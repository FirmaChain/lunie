'use strict'

let { app, BrowserWindow, Menu } = require('electron')
let fs = require('fs-extra')
let { join } = require('path')
let { spawn } = require('child_process')
let home = require('user-home')
let RpcClient = require('tendermint')
let semver = require('semver')
// this dependency is wrapped in a file as it was not possible to mock the import with jest any other way
let event = require('event-to-promise')
let toml = require('toml')
let pkg = require('../../package.json')
let rmdir = require('../helpers/rmdir.js')

let shuttingDown = false
let mainWindow
let basecoinProcess, baseserverProcess, tendermintProcess
let streams = []
const DEV = process.env.NODE_ENV === 'development'
const TEST = JSON.parse(process.env.COSMOS_TEST || 'false') !== false
// TODO default logging or default disable logging?
const LOGGING = JSON.parse(process.env.LOGGING || DEV) !== false
const winURL = DEV
  ? `http://localhost:${require('../../../config').port}`
  : `file://${__dirname}/index.html`

// this network gets used if none is specified via the
// COSMOS_NETWORK env var
let DEFAULT_NETWORK = join(__dirname, '../networks/tak')

let NODE_BINARY = 'basecoin'
let SERVER_BINARY = 'baseserver'

function log (...args) {
  if (LOGGING) {
    console.log(...args)
  }
}

function logProcess (process, logPath) {
  fs.ensureFileSync(logPath)
  // Writestreams are blocking fs cleanup in tests, if you get errors, disable logging
  if (LOGGING) {
    let logStream = fs.createWriteStream(logPath)
    streams.push(logStream)
    process.stdout.pipe(logStream)
    process.stderr.pipe(logStream)
  }
}

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function expectCleanExit (process, errorMessage = 'Process exited unplaned') {
  return new Promise((resolve, reject) => {
    process.on('exit', code => {
      if (code !== 0 && !shuttingDown) {
        throw new Error(errorMessage)
      }
      resolve()
    })
  })
}

function shutdown () {
  if (shuttingDown) return

  mainWindow = null
  shuttingDown = true

  if (basecoinProcess) {
    log('killing basecoin')
    basecoinProcess.kill('SIGKILL')
    basecoinProcess = null
  }
  if (baseserverProcess) {
    log('killing baseserver')
    baseserverProcess.kill('SIGKILL')
    baseserverProcess = null
  }
  if (tendermintProcess) {
    log('killing tendermint')
    tendermintProcess.kill('SIGKILL')
    tendermintProcess = null
  }

  return Promise.all(
    streams.map(stream => new Promise((resolve) => stream.close(resolve)))
  )
}

function createWindow () {
  mainWindow = new BrowserWindow({
    minWidth: 320,
    minHeight: 480,
    width: 1200,
    height: 800,
    webPreferences: { webSecurity: false }
  })
  // mainWindow.maximize()

  mainWindow.loadURL(winURL)
  if (DEV || process.env.COSMOS_DEVTOOLS) {
    mainWindow.webContents.openDevTools()
  }

  mainWindow.on('closed', shutdown)

  // eslint-disable-next-line no-console
  log('mainWindow opened')

  // handle opening external links in OS's browser
  let webContents = mainWindow.webContents
  let handleRedirect = (e, url) => {
    if (url !== webContents.getURL()) {
      e.preventDefault()
      require('electron').shell.openExternal(url)
    }
  }
  webContents.on('will-navigate', handleRedirect)
  webContents.on('new-window', handleRedirect)

  // setup menu to handle copy/paste, etc
  var template = [
    {
      label: 'Cosmos UI',
      submenu: [
        { label: 'About Cosmos UI', selector: 'orderFrontStandardAboutPanel:' },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'Command+Q', click: () => app.quit() }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', selector: 'undo:' },
        { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', selector: 'redo:' },
        { type: 'separator' },
        { label: 'Cut', accelerator: 'CmdOrCtrl+X', selector: 'cut:' },
        { label: 'Copy', accelerator: 'CmdOrCtrl+C', selector: 'copy:' },
        { label: 'Paste', accelerator: 'CmdOrCtrl+V', selector: 'paste:' },
        { label: 'Select All', accelerator: 'CmdOrCtrl+A', selector: 'selectAll:' }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function startProcess (name, args, env) {
  let binPath
  if (DEV || TEST) {
    // in dev mode or tests, use binaries installed in GOPATH
    let GOPATH = process.env.GOPATH
    if (!GOPATH) GOPATH = join(home, 'go')
    binPath = join(GOPATH, 'bin', name)
  } else {
    // in production mode, use binaries packaged with app
    binPath = join(__dirname, '..', 'bin', name)
  }

  let argString = args.map((arg) => JSON.stringify(arg)).join(' ')
  log(`spawning ${binPath} with args "${argString}"`)
  let child = spawn(binPath, args, env)
  child.stdout.on('data', (data) => !shuttingDown && log(`${name}: ${data}`))
  child.stderr.on('data', (data) => !shuttingDown && log(`${name}: ${data}`))
  child.on('exit', (code) => !shuttingDown && log(`${name} exited with code ${code}`))
  child.on('error', function (err) {
    if (!(shuttingDown && err.code === 'ECONNRESET')) {
      // Ignore ECONNRESET and re throw anything else
      throw err
    }
  })
  return child
}

app.on('ready', createWindow)

app.on('window-all-closed', () => {
  app.quit()
})

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow()
  }
})

// start tendermint node
async function startTendermint (root) {
  let opts = {
    env: {
      BCHOME: root,
      TMROOT: root
    }
  }

  let args = [
    'node',
    '--home', root
  ]
  // if (DEV) args.push('--log_level', 'info')
  let child = startProcess('tendermint', args, opts)
  logProcess(child, join(root, 'tendermint.log'))
  expectCleanExit(child, 'Tendermint exited unplanned')

  let rpc = RpcClient('localhost:46657')
  let status = () => new Promise((resolve, reject) => {
    rpc.status((err, res) => {
      // ignore connection errors, since we'll just poll until we get a response
      if (err && err.code !== 'ECONNREFUSED') {
        reject(err)
        return
      }
      resolve(res)
    })
  })
  let noFailure = true
  while (noFailure) {
    if (shuttingDown) return

    log('trying to get tendermint RPC status')
    let res = await status()
      .catch(e => {
        noFailure = false
        throw new Error(`Tendermint produced an unexpected error: ${e.message}`)
      })
    if (res) {
      if (res.latest_block_height > 0) break
      log('waiting for blockchain to start syncing')
    }
    await sleep(1000)
  }

  return child
}

// start baseserver REST API
async function startBaseserver (home) {
  log('startBaseserver', home)
  let child = startProcess(SERVER_BINARY, [
    'serve',
    '--home', home // ,
    // '--trust-node'
  ])
  logProcess(child, join(home, 'baseserver.log'))

  // restore baseserver if it crashes
  child.on('exit', async () => {
    if (shuttingDown) return
    log('baseserver crashed, restarting')
    await sleep(1000)
    await startBaseserver(home)
  })

  while (true) {
    if (shuttingDown) break

    let data = await event(child.stderr, 'data')
    if (data.toString().includes('Serving on')) break
  }

  return child
}

function exists (path) {
  try {
    fs.accessSync(path)
    return true
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
    return false
  }
}

async function initBaseserver (chainId, home, node) {
  // `baseserver init` to generate config, trust seed
  let child = startProcess(SERVER_BINARY, [
    'init',
    '--home', home,
    '--chain-id', chainId,
    '--node', node,
    // '--trust-node'
  ])
  child.stdout.on('data', (data) => {
    if (shuttingDown) return
    // answer 'y' to the prompt about trust seed. we can trust this is correct
    // since the baseserver is talking to our own full node
    child.stdin.write('y\n')
  })
  await expectCleanExit(child, 'Baseserver init exited unplanned')
}

async function backupData (root) {
  let i = 1
  let path
  do {
    path = `${root}_backup_${i}`
    i++
  } while (exists(path))

  log(`backing up data to "${path}"`)
  fs.copySync(root, path, {
    overwrite: false,
    errorOnExist: true
  })
  await rmdir(root)
}

process.on('exit', shutdown)

async function main () {
  let root = require('../root.js')
  let versionPath = join(root, 'app_version')
  let genesisPath = join(root, 'genesis.json')

  let init = true
  if (exists(root)) {
    log(`root exists (${root})`)

    // check if the existing data came from a compatible app version
    // if not, backup the data and re-initialize
    if (exists(versionPath)) {
      let existingVersion = fs.readFileSync(versionPath, 'utf8')
      let compatible = semver.diff(existingVersion, pkg.version) !== 'major'
      if (compatible) {
        log('configs are compatible with current app version')
        init = false
      } else {
        await backupData(root)
      }
    } else {
      await backupData(root)
    }

    // check to make sure the genesis.json we want to use matches the one
    // we already have. if it has changed, back up the old data
    if (!init) {
      let existingGenesis = fs.readFileSync(genesisPath, 'utf8')
      let genesisJSON = JSON.parse(existingGenesis)
      // skip this check for local testnet
      if (genesisJSON.chain_id !== 'local') {
        let specifiedGenesis = fs.readFileSync(join(process.env.COSMOS_NETWORK, 'genesis.json'), 'utf8')
        if (existingGenesis.trim() !== specifiedGenesis.trim()) {
          log('genesis has changed')
          await backupData(root)
          init = true
        }
      }
    }
  }

  if (init) {
    log(`initializing data directory (${root})`)
    await fs.ensureDir(root)

    // copy predefined genesis.json and config.toml into root
    let networkPath = process.env.COSMOS_NETWORK || DEFAULT_NETWORK
    fs.accessSync(networkPath) // crash if invalid path
    fs.copySync(networkPath, root)

    fs.writeFileSync(versionPath, pkg.version)
  }

  if (!DEV && !TEST) {
    let logFilePath = join(root, 'main.log')
    log('Redirecting console output to logfile', logFilePath)
    // redirect stdout/err to logfile
    // TODO overwriting console.log sounds like a bad idea, can we find an alternative?
    let mainLog = fs.createWriteStream(logFilePath)
    streams.push(mainLog)
    // eslint-disable-next-line no-func-assign
    log = function (...args) {
      mainLog.write(`${args.join(' ')}\n`)
    }
    console.error = function (...args) {
      mainLog.write(`stderr: ${args.join(' ')}\n`)
    }
  }

  log('starting app')
  log(`dev mode: ${DEV}`)
  log(`winURL: ${winURL}`)

  // read chainId from genesis.json
  let genesisText
  try {
    genesisText = fs.readFileSync(genesisPath, 'utf8')
  } catch (e) {
    throw new Error(`Can't open genesis.json: ${e.message}`)
  }
  let genesis = JSON.parse(genesisText)
  let chainId = genesis.chain_id

  // pick a random seed node from config.toml
  // TODO: user-specified nodes, support switching?
  let configText
  try {
    configText = fs.readFileSync(join(root, 'config.toml'), 'utf8')
  } catch (e) {
    throw Error(`Can't open config.toml: ${e.message}`)
  }
  let config = toml.parse(configText)
  let seeds = config.p2p.seeds.split(',')
  if (seeds.length === 0) {
    throw Error('No seeds specified in config.toml')
  }
  let node = seeds[Math.floor(Math.random() * seeds.length)]
  // replace port with default RPC port
  node = `${node.split(':')[0]}:46657`
  log(`Initializing baseserver with remote node ${node}`)

  let baseserverHome = join(root, 'baseserver')
  if (init) {
    await initBaseserver(chainId, baseserverHome, node)
  }

  log('starting baseserver')
  baseserverProcess = await startBaseserver(baseserverHome)
  .catch(e => {
    e.message = `Can't start baseserver: ${e.message}`
    throw e
  })
  log('baseserver ready')
}
module.exports = Object.assign(
  main()
  // HACK if we need process.exit(1) we can wrap this whole file in another file
  // We need the responses from main to test
  // .catch(function (err) {
  //   console.error('Error in main process:', err.stack)
  //   // process.exit(1)
  // })
  .then(() => ({
    shutdown,
    processes: {baseserverProcess}
  }))
)
