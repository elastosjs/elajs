import constants from './constants'

const config = {
  [constants.NETWORK.LOCAL]: {
    relayHubAddress: '0xD216153c06E857cD7f72665E0aF1d7D82172F494'
  },
  [constants.NETWORK.TESTNET]: {
    relayHubAddress: '0x2EDA8d1A61824dFa812C4bd139081B9BcB972A6D'
  }
}

export default config
