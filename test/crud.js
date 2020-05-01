
const chai = require('chai')
const expect = chai.expect
const assert = chai.assert

const AssertionError = chai.AssertionError

const { elajs } = require('../dist/ela-js.cjs')

const Web3 = require('web3')
const HDWalletProvider = require('@truffle/hdwallet-provider')
const { fromConnection, ephemeral } = require("@openzeppelin/network")

// const ELAJSStoreJSON = require('../src/contracts/ELAJSStore.json')

describe('Tests for Insert Data', () => {

  let ozWeb3, web3, ephemeralInstance, ownerInstance, elajsDb

  const TEST_TABLE = 'user' + Web3.utils.randomHex(3).substring(2)
  const TEST_COLS = ['firstName', 'age', 'some_data', 'some_bool']
  const TEST_COL_TYPES = ['STRING', 'UINT', 'BYTES32', 'BOOL']

  let rowId, rowId2, randomBytes

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

  it('Should insert a row of data - ephemerally', async () => {

    randomBytes = Web3.utils.randomHex(32)

    // raw
    const vals = [
      'John',
      30,
      randomBytes,
      true
    ]

    rowId = await elajsDb.insertRow(TEST_TABLE, TEST_COLS, vals)

  })

  it('Should check the previous row of data', async () => {

    const rowData = await elajsDb.getRow(TEST_TABLE, rowId)

    expect(rowData[0].value).to.be.equal('John')
    expect(rowData[1].value).to.be.equal(30)
    expect(rowData[2].value).to.be.equal(randomBytes)
    expect(rowData[3].value).to.be.equal(true)
  })

  it('Should fail inserting insert a row of data - wrong type, then missing col, then unknown length mismatch', async () => {

    randomBytes = Web3.utils.randomHex(32)

    // raw
    const vals = [
      55,
      30,
      randomBytes,
      true
    ]

    try {
      rowId = await elajsDb.insertRow(TEST_TABLE, TEST_COLS, vals)
      assert.fail('insertRow should fail with wrong value type')
    } catch (err){
      expect(err).to.not.be.an.instanceof(AssertionError)
    }

    const testCols = TEST_COLS.slice()
    vals[0] = 'Timmy' // set this back to be correct
    testCols[2] = 'unknown_col'

    try {
      rowId = await elajsDb.insertRow(TEST_TABLE, testCols, vals)
      assert.fail('insertRow should fail with unknown column')
    } catch (err){
      expect(err).to.not.be.an.instanceof(AssertionError)
    }

    vals.shift(1)

    try {
      rowId = await elajsDb.insertRow(TEST_TABLE, testCols, vals)
      assert.fail('insertRow should fail with col and value length mismatch')
    } catch (err){
      expect(err).to.not.be.an.instanceof(AssertionError)
    }
  })

  it('Should insert a row of data - with private key', async () => {

    // raw
    const vals = [
      'Mary',
      88123,
      randomBytes,
      false
    ]

    rowId2 = await elajsDb.insertRow(TEST_TABLE, TEST_COLS, vals, {ethAddress: web3.eth.personal.currentProvider.addresses[0]})

  })

  it('Should check the previous row of data', async () => {

    const rowData = await elajsDb.getRow(TEST_TABLE, rowId2)

    expect(rowData[0].value).to.be.equal('Mary')
    expect(rowData[1].value).to.be.equal(88123)
    expect(rowData[2].value).to.be.equal(randomBytes)
    expect(rowData[3].value).to.be.equal(false)
  })

  it('Should return 2 rows of data', async () => {

    const ids = await elajsDb.getTableIds(TEST_TABLE)

    expect(ids.length).to.be.equal(2)

  })

  it('Should fail updating because id does not exist', async () => {
    try {
      await elajsDb._updateVal(TEST_TABLE, Web3.utils.randomHex(32), 'firstName', 'Marianne')
      assert.fail('_updateVal should fail because id does not exist')
    } catch (err){
      expect(err).to.not.be.an.instanceof(AssertionError)
    }
  })

  it('Should fail updating because column does not exist', async () => {
    try {
      await elajsDb._updateVal(TEST_TABLE, Web3.utils.randomHex(32), 'lastName', 'Smith')
      assert.fail('_updateVal should fail because col does not exist')
    } catch (err){
      expect(err).to.not.be.an.instanceof(AssertionError)
    }
  })

  it('Should fail updating the column due to ownership', async () => {

    const newFirstName = 'Marianne'

    try {
      await elajsDb._updateVal(TEST_TABLE, rowId2, 'firstName', newFirstName)
      assert.fail('_updateVal should fail because signer is not the row owner')
    } catch (err){
      expect(err).to.not.be.an.instanceof(AssertionError)
    }
  })

  it('Should update the column', async () => {

    const newFirstName = 'Marianne'

    await elajsDb._updateVal(TEST_TABLE, rowId2, 'firstName', newFirstName, {ethAddress: web3.eth.personal.currentProvider.addresses[0]})

    const rowData = await elajsDb.getRow(TEST_TABLE, rowId2)

    expect(rowData[0].value).to.be.equal(newFirstName)

    // also try direct value fetch
    const colVal = await elajsDb.getVal(TEST_TABLE, rowId2, 'firstName', 'STRING')

    expect(colVal).to.be.equal(newFirstName)
  })

  it('Should fail to delete the row, because it does not exist', async () => {
    try {
      await elajsDb.deleteRow(TEST_TABLE, Web3.utils.randomHex(32))
      assert.fail('deleteRow should fail because row does not exist')
    } catch (err){
      expect(err).to.not.be.an.instanceof(AssertionError)

      // proper error msgs only available locally
      if (process.env.NODE_ENV === 'local'){
        expect(/revert id doesn't exist/.test(err.message)).to.be.true
      }
    }
  })

  it('Should fail to delete the row, because not row owner', async () => {
    try {
      await elajsDb.deleteRow(TEST_TABLE, rowId2)
      assert.fail('deleteRow should fail because signer is not the row owner')
    } catch (err){
      expect(err).to.not.be.an.instanceof(AssertionError)

      // proper error msgs only available locally
      if (process.env.NODE_ENV === 'local'){
        expect(/revert Sender not owner of row/.test(err.message)).to.be.true
      }
    }
  })

  it('Should delete the row', async () => {
    await elajsDb.deleteRow(TEST_TABLE, rowId2, {ethAddress: web3.eth.personal.currentProvider.addresses[0]})

    const ids = await elajsDb.getTableIds(TEST_TABLE)

    expect(ids.length).to.be.equal(1)

    expect(ids[0]).to.be.equal(rowId)
  })
})
