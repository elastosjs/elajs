
const chai = require('chai')
const expect = chai.expect
const assert = chai.assert

const AssertionError = chai.AssertionError

const { ELA_JS } = require('../dist/ela-js.cjs')

const Web3 = require('web3')
const HDWalletProvider = require('@truffle/hdwallet-provider')
const { fromConnection, ephemeral } = require("@openzeppelin/network")

describe('Tests for Create Table/Schema', () => {

  let ozWeb3, web3, ephemeralInstance, elajs

  const TEST_TABLE = 'test_table'
  const TEST_COLS = ['name', 'age', 'some_data'].map((colName) => Web3.utils.stringToHex(colName))
  const TEST_COL_TYPES = ['STRING', 'UINT', 'BYTES32'].map((colName) => Web3.utils.stringToHex(colName))

  before(async () => {

    ozWeb3 = await fromConnection (process.env.PROVIDER_URL, {
      gsn: { signKey: ephemeral() },
      pollInterval: 5000,

      // keep these as strings
      fixedGasPrice: process.env.GAS_PRICE,
      fixedGasLimit: process.env.GAS_LIMIT
    })

    web3 = new Web3(new HDWalletProvider(
      process.env.MNEMONIC, process.env.PROVIDER_URL
    ))

    elajs = new ELA_JS({
      defaultWeb3: web3,
      ephemeralWeb3: ozWeb3,
      contractAddress: process.env.ELAJSSTORE_CONTRACT_ADDR
    })
  })

  it('Should error creating a table - not owner', async () => {

    const ephemeralAddr = (await ozWeb3.lib.eth.getAccounts())[0]

    console.log(ephemeralAddr)

    try {
      await elajs.createTable(TEST_TABLE, 1, TEST_COLS, TEST_COL_TYPES, ephemeralAddr)
      assert.fail('create table should fail with unknown address')
    } catch (err){
      expect(err).to.not.be.an.instanceof(AssertionError)
    }
  })

  it('Should fail to create a table (col vs types count mismatch)', async () => {

    const modifiedColTypesAry = TEST_COL_TYPES.slice()

    modifiedColTypesAry.shift()

    try {
      await elajs.createTable(TEST_TABLE, 1, TEST_COLS, modifiedColTypesAry)
      assert.fail('create table should fail with array len mismatch')
    } catch (err){
      expect(err).to.not.be.an.instanceof(AssertionError)
    }

  })

  it('Should create a table with schema and return it', async () => {

    // we don't need to pass an ethAddress because it knows how to use a local web3
    await elajs.createTable(TEST_TABLE, 1, TEST_COLS, TEST_COL_TYPES)

    // TODO: we should directly call the SC and check for the table

    const schema = await elajs.getTableSchema(TEST_TABLE)

    const colsResult = schema.columns.map((colData) => {
      return {
        name: Web3.utils.hexToString(colData.name),
        type: Web3.utils.hexToString(colData._dtype),
      }
    })

    // console.log(colsResult)

    expect(colsResult.length).to.be.equal(3)

    expect(colsResult[2].name).to.be.equal('some_data')
    expect(colsResult[2].type).to.be.equal('BYTES32')
  })

})
