
const chai = require('chai')
const expect = chai.expect
const assert = chai.assert

const AssertionError = chai.AssertionError

const _ = require('lodash')

// this redeploys the contracts, and has side-effects, see file docs
// require('.setup')

require('./config')

const ELAJSStoreJSON = require('../src/contracts/ELAJSStore.json')

const { fromConnection, ephemeral } = require("@openzeppelin/network")

// TODO: we could fetch the mnemonic from the local ganache and add it to the .env
// const HDWalletProvider = require('@truffle/hdwallet-provider')

const requireDirectory = require('require-directory')


/**
 * These are all late tests for QA
 *
 * IMPORTANT: You must re-deploy the smart contract before each run since we use
 * hardcoded table names and such
 */
describe('ELAJS Tests', function(){

  let ozWeb3, ephemeralInstance

  before(async () => {

    ozWeb3 = await fromConnection (process.env.PROVIDER_URL, {
      gsn: { signKey: ephemeral() },
      pollInterval: 5000,

      // keep these as strings
      fixedGasPrice: process.env.GAS_PRICE,
      fixedGasLimit: process.env.GAS_LIMIT
    })

    ephemeralInstance = new ozWeb3.lib.eth.Contract(ELAJSStoreJSON.abi, process.env.ELAJSSTORE_CONTRACT_ADDR)

  })

  if (process.env.NODE_ENV === 'local') {
    // calls only throw errors locally
    it('Should error because this contract address does not exist', async () => {
      const fakeContractAddr = '0xb9A7C26DEA47Fc965f5c5311dd5618C0c6B97f13'
      const fakeInstance = new ozWeb3.lib.eth.Contract(ELAJSStoreJSON.abi, fakeContractAddr)
      try {
        await fakeInstance.methods.owner().call()
        assert.fail('owner fetch should fail / not be defined for fakeContractAddr')
      } catch (err){
        expect(err).to.not.be.an.instanceof(AssertionError)
      }
    })
  }

  it('Should return our default owner', async () => {
    const owner = await ephemeralInstance.methods.owner().call()
    expect(owner).to.equal(process.env.DEFAULT_WALLET)
  })

  it(`Should return a GSN Balance if it's initialized properly`, async () => {
    const gsnBalance = await ephemeralInstance.methods.getGSNBalance().call()
    expect(gsnBalance > 0).to.be.true
  })

  requireDirectory(module, './', {exclude: /(index\.js)|(config\.js)|(setup\.js)|(\.json)|(postman)/})
})

