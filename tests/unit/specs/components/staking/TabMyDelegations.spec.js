import { shallowMount } from "@vue/test-utils"
import TabMyDelegations from "src/components/staking/TabMyDelegations"
import validators from "../../store/json/validators.js"
import { flatOrderedTransactionList } from "../../store/json/txs"

describe(`Component: TabMyDelegations`, () => {
  const state = {
    delegates: {
      delegates: validators
    },
    delegation: {
      unbondingDelegations: {},
      loaded: true
    },
    session: { signedIn: true }
  }
  const getters = {
    committedDelegations: {},
    connected: true,
    bondDenom: `uatom`,
    flatOrderedTransactionList
  }

  describe(`view`, () => {
    let wrapper, $store

    beforeEach(() => {
      $store = {
        commit: jest.fn(),
        dispatch: jest.fn(),
        state,
        getters: JSON.parse(JSON.stringify(getters)) // clone so we don't overwrite by accident
      }

      wrapper = shallowMount(TabMyDelegations, {
        mocks: {
          $store,
          $route: {
            path: `/staking/my-delegations`
          }
        },
        stubs: [`router-link`]
      })
    })

    it(`should show committed validators`, () => {
      $store.getters.committedDelegations = {
        [validators[0].operator_address]: 42
      }
      expect(wrapper.element).toMatchSnapshot()
    })

    it(`should show message when no commited validators`, () => {
      expect(wrapper.text()).toMatch(/No Active Delegations/)
      expect(wrapper.element).toMatchSnapshot()
    })

    it(`should show sign in message when not signed in`, () => {
      $store = {
        commit: jest.fn(),
        dispatch: jest.fn(),
        state: {
          delegation: {
            unbondingDelegations: {},
            loaded: true
          },
          session: { signedIn: false }
        },
        getters: JSON.parse(JSON.stringify(getters))
      }
      wrapper = shallowMount(TabMyDelegations, {
        mocks: {
          $store
        },
        stubs: [`router-link`]
      })
      expect(wrapper.find("cardsigninrequired-stub").exists()).toBe(true)
      expect(wrapper.element).toMatchSnapshot()
    })

    it(`should show message when loading and not connected`, () => {
      $store = {
        commit: jest.fn(),
        dispatch: jest.fn(),
        state: {
          delegation: {
            unbondingDelegations: {},
            loaded: true
          },
          session: { signedIn: true }
        },
        getters: JSON.parse(JSON.stringify(getters))
      }
      $store.state.delegation.loaded = false
      $store.getters.connected = false
      wrapper = shallowMount(TabMyDelegations, {
        mocks: {
          $store
        },
        stubs: [`router-link`]
      })
      expect(wrapper.find("TmDataConnecting-stub").exists()).toBe(true)
      expect(wrapper.element).toMatchSnapshot()
    })

    it(`should show loading message`, () => {
      $store = {
        commit: jest.fn(),
        dispatch: jest.fn(),
        state: {
          delegation: {
            unbondingDelegations: {},
            loaded: true
          },
          session: { signedIn: true }
        },
        getters: JSON.parse(JSON.stringify(getters))
      }
      $store.state.delegation.loaded = false
      $store.state.delegation.loading = true
      wrapper = shallowMount(TabMyDelegations, {
        mocks: {
          $store
        },
        stubs: [`router-link`]
      })
      expect(wrapper.find("TmDataLoading-stub").exists()).toBe(true)
      expect(wrapper.element).toMatchSnapshot()
    })

    it(`should show pending undelegations`, () => {
      $store = {
        commit: jest.fn(),
        dispatch: jest.fn(),
        state: {
          delegates: {
            delegates: validators
          },
          delegation: {
            unbondingDelegations: {},
            loaded: true
          },
          session: { signedIn: true }
        },
        getters: JSON.parse(JSON.stringify(getters))
      }

      $store.state.delegation.loaded = true
      $store.state.delegation.loading = false
      $store.getters.committedDelegations = {
        [`cosmos1`]: 42
      }
      $store.state.delegates.delegates = [{ operator_address: `cosmos1` }]

      wrapper = shallowMount(TabMyDelegations, {
        mocks: {
          $store
        },
        stubs: [`router-link`, `tablevalidators-stub`]
      })

      expect(wrapper.html()).toMatch(/Pending Undelegations/)
      expect(wrapper.vm.$el).toMatchSnapshot()
    })
  })
})