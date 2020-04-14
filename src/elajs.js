
import { keccak256 } from './keccak256'
import { namehash } from './namehash'
import Web3 from 'web3'

import constants from './constants'

import ELAJSStoreJSON from './contracts/ELAJSStore.json'

/**
 * TODO: consistent returns of promise
 * - Must support ephemeral (anonymous calls)
 * - Needs to have a way to connect to Fortmatic
 * - Do we expect the parent app to pass in the ozWeb3 and fmWeb3?
 * - do we track state and an entire table schema? cached?
 * - web3 should definitely be external, we pass it in and instantiate the contract
 */
class ELA_JS {

  /**
   *
   * @param options
   */
  constructor(options){

    console.log('constructor')

    /*
    ************************************************************************************************************
    * Passed In
    ************************************************************************************************************
     */
    this.contractAddress = options.contractAddress

    /*
     This could be 1 of 2 possibilities
     1. The storage contract owner is running in a secure env and this is the owner of the storage contract.
        However for most of the developers they will have a Fortmatic account and need to export the priv key
        to take advantage of this, so they will be stuck using the ElastosJS GUI or import this into a custom
        app.

     2. This is deployed and the user is not the owner, most likely case.
     */
    this.defaultWeb3 = options.defaultWeb3

    // this is the ephemeral signer for anonymous calls which don't prompt for a signature
    this.ephemeralWeb3 = options.ephemeralWeb3



    /*
    ************************************************************************************************************
    * Internal
    ************************************************************************************************************
     */

    // default instance
    this.defaultInstance = null

    // ephemeral instance
    this.ephemeralInstance = null

    this.ozWeb3 = null
    this.fmWeb3 = null

    this.schema = {}

    this._initialize()

    this.config = {
      gasPrice: '1000000000'
    }

    this.debug = true
  }

  /**
   * We should setup the web3 components if not passed in
   * @private
   */
  _initialize(){


    if (this.defaultWeb3){
      this.defaultInstance = new this.defaultWeb3.eth.Contract(ELAJSStoreJSON.abi, this.contractAddress)
    }

    if (this.ephemeralWeb3){
      // the ozWeb3 is constructed slightly differently
      this.ephemeralInstance = new this.ephemeralWeb3.lib.eth.Contract(ELAJSStoreJSON.abi, this.contractAddress)
    }

    // 1. fetch table list
    // 2. lazy fetch schema?
  }

  setProvider(provider){

  }

  // fm call only
  async createTable(tableName, permission, cols, colTypes){

    const tableNameValue = Web3.utils.stringToHex(tableName)
    const tableKey = namehash(tableName)

    if (this.debug){
      console.log('createTable', tableKey)
      console.log(tableNameValue)

      // this should only work locally, fortmatic would use a different path
      console.log(this.defaultWeb3.eth.personal.currentProvider.addresses[0])

      console.log('gasPrice', this.config.gasPrice)
    }

    await this.defaultInstance.methods.createTable(
      tableNameValue,
      tableKey,
      permission,
      cols,
      colTypes
    ).send({
      from: this.defaultWeb3.eth.personal.currentProvider.addresses[0],
      gasPrice: this.config.gasPrice
    })
  }

  async getTables(){
    return await this.ephemeralInstance.methods.getTables().call()
  }

  async getTableMetadata(tableName){

    const tableKey = namehash(tableName)

    return await this.ephemeralInstance.methods.getTableMetadata(tableKey).call()
  }

  async getTableSchema(tableName){
    const tableKey = namehash(tableName)

    return await this.ephemeralInstance.methods.getSchema(tableKey).call()
  }

  async getTableIds(tableName){
    const tableKey = namehash(tableName)

    return await this.ephemeralInstance.methods.getTableIds(tableKey).call()
  }

  /**
   * The storage smart contract does not support auto_increment ids, therefore we
   * always generate randomBytes
   *
   * TODO: we really want to return a Promise immediately, which resolves to all the inserts
   *
   * There are 3 types of tables
   * 1 = private, must be FORTMATIC signer and only works if it's the owner
   * 2 = public, can be any signer
   * 3 = shared, can be any signer
   *
   * @param tableName
   * @param cols Array of column names, name must be 32 chars or less
   * @param colTypes Array of column types
   * @param values For now we just require byte32 values
   * @param options - struct
   * @param options.signer -
   */
  async insertRow(tableName, cols, values, options){

    if (options.id && (options.id.substring(0, 2) !== '0x' || options.id.length !== 66)){
      throw new Error('options.id must be a 32 byte hex string prefixed with 0x')
    }

    if (cols.length !== values.length){
      throw new Error('cols, values arrays must be same length')
    }

    const id = options.id || Web3.utils.randomHex(32)

    const {idKey, tableKey, idTableKey} = this._getKeys(tableName, id.substring(2))

    // TODO: check cache for table schema? Be lazy for now and always check?

    for (let i = 0; i < cols.length; i++){

      let fieldIdTableKey = namehash(`${cols[i]}.${id.substring(2)}.${tableName}`)
      console.log(`fieldIdTableKey = ${fieldIdTableKey}`)
      let fieldKey = keccak256(cols[i])

      await this.ephemeralInstance.methods.insertVal(
        tableKey,
        idTableKey,
        fieldIdTableKey,
        idKey,
        fieldKey,
        id,
        values[i]
      ).send({
        from: this.ephemeralWeb3.accounts[0]
      })
    }
  }

  /**
   * Returns a promise
   *
   * TODO: the promise should resolve with the fieldIdTableKey and transaction hash
   *
   * @param tableName
   * @param col
   * @param val
   * @param options
   * @returns {*}
   */
  insertVal(tableName, col, val, options){

    if (options.id && (options.id.substring(0, 2) !== '0x' || options.id.length !== 66)){
      throw new Error('options.id must be a 32 byte hex string prefixed with 0x')
    }

    const id = options.id || Web3.utils.randomHex(32)

    const {idKey, tableKey, idTableKey} = this._getKeys(tableName, id.substring(2))
    const fieldIdTableKey = namehash(`${col}.${id.substring(2)}.${tableName}`)
    console.log(`fieldIdTableKey = ${fieldIdTableKey}`)
    const fieldKey = keccak256(col)

    return this.ephemeralInstance.methods.insertVal(
      tableKey,
      idTableKey,
      fieldIdTableKey,
      idKey,
      fieldKey,
      id,
      val
    ).send({
      from: this.ephemeralWeb3.accounts[0]
    })
  }

  /**
   * This is a call so we can always use ephemeral
   *
   * @param tableName
   * @param id - Should not have leading 0x
   * @param fieldName
   * @private
   * @returns promise
   */
  _getVal(tableName, id, fieldName){

    if (id.substring(0, 2) !== '0x' || id.length !== 66){
      throw new Error('id must be a 32 byte hex string prefixed with 0x')
    }

    // always strip the 0x
    id = id.substring(2)

    const fieldIdTableKey = namehash(`${fieldName}.${id}.${tableName}`)

    let result = this.ephemeralInstance.methods.getRowValue(fieldIdTableKey).call()

    // TODO: type parsing? How to ensure this is fresh?
    // and so what if it isn't? We can't really change a field type right?
    // const fieldType = this.schema[tableKey][fieldKey].type

    /*
    switch (fieldType) {

      case constants.FIELD_TYPE.NUMBER:
        result = Web3.utils.hexToNumber(result)
        break
    }
     */

    return result
  }

  /**
   * Update a single val, should be called by another fn
   * @private
   */
  _updateVal(){

  }

  deleteRow(){

  }

  async getGSNBalance(){
    return await this.ephemeralInstance.methods.getGSNBalance().call()
  }

  /*
  ************************************************************************************************************
  * Internal
  ************************************************************************************************************
   */
  _getKeys(tableName, id){

    if (id.substring(0, 2) === '0x'){
      throw new Error('internal fn _getKeys expects id without 0x prefix')
    }

    const idKey = keccak256(id)
    const tableKey = namehash(tableName)
    const idTableKey = namehash(`${id}.${tableName}`)

    return {idKey, tableKey, idTableKey}
  }

  /*
   ******************************************************************************************************
   * Query Functions
   ******************************************************************************************************
   */

  /**
   * Returns a chainable select object, that finally resolves to a callable Promise
   */
  select(){

    // return this? - need to instantiate and return a new Class instance for chaining

    // pass a reference to elajs into the constructor?
  }
}

export default ELA_JS
