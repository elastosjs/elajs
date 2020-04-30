
const chai = require('chai')
const expect = chai.expect
const assert = chai.assert

const AssertionError = chai.AssertionError

const { elajs, uintToBytes32, namehash, keccak256 } = require('../dist/ela-js.cjs')

const Web3 = require('web3')
const HDWalletProvider = require('@truffle/hdwallet-provider')
const { fromConnection, ephemeral } = require("@openzeppelin/network")

const ELAJSStoreJSON = require('../src/contracts/ELAJSStore.json')

describe('Tests for Insert Data', () => {

  let ozWeb3, web3, ephemeralInstance, ownerInstance, elajsDb

  const TEST_TABLE = 'user'// + Web3.utils.randomHex(3).substring(2)
  const TEST_COLS = ['firstName', 'age', 'some_data']
  const TEST_COL_TYPES = ['STRING', 'UINT', 'BYTES32']

  let rowId, randomBytes

  before(async () => {

    ozWeb3 = await fromConnection(process.env.PROVIDER_URL, {
      gsn: { signKey: ephemeral() },
      pollInterval: 5000,

      // keep these as strings
      fixedGasPrice: process.env.GAS_PRICE,
      fixedGasLimit: parseInt(process.env.GAS_LIMIT)
    })

    web3 = new Web3(new HDWalletProvider(
      process.env.MNEMONIC, process.env.PROVIDER_URL
    ))

    elajsDb = new elajs.database({
      defaultWeb3: web3,
      ephemeralWeb3: ozWeb3,

      databaseContractAddr: process.env.ELAJSSTORE_CONTRACT_ADDR,
      relayHubAddr: process.env.RELAY_HUB_ADDR,

      debug: true
    })

    await elajsDb.createTable(TEST_TABLE, 2, TEST_COLS, TEST_COL_TYPES)
  })

  it('Should insert a row of data', async () => {

    randomBytes = Web3.utils.randomHex(32)

    // raw
    const vals = [
      'John',
      30,
      randomBytes
    ]

    rowId = await elajsDb.insertRow(TEST_TABLE, TEST_COLS, vals) //, {ethAddress: web3.eth.personal.currentProvider.addresses[0]})

  })

  it('Should check the row of data', async () => {

    const rowData = await elajsDb.getRow(TEST_TABLE, rowId)

    expect(rowData[0].value).to.be.equal('John')
    expect(rowData[1].value).to.be.equal(30)
    expect(rowData[2].value).to.be.equal(randomBytes)
  })




})
