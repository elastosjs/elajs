import ELAJSStoreJSON from './contracts/ELAJSStore.json'
import { namehash } from './namehash'
import Web3 from 'web3'
import { keccak256 } from './keccak256'
import { uintToBytes32 } from './typesToBytes'
import constants from './constants'
import relayHubData from './relay-hub/data'
import check from 'check-types'

export default class database {

  /**
   *
   * @param options
   */
  constructor(options){

    if (!(options.defaultWeb3 && options.ephemeralWeb3)){
      throw new Error('Missing required constructor args')
    }

    /*
    ************************************************************************************************************
    * Passed In
    ************************************************************************************************************
     */
    this.databaseContractAddr = options.databaseContractAddr
    this.relayHubAddr = options.relayHubAddr

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

    // default instance - points to ElastosJS contract
    this.defaultInstance = null

    // ephemeral instance - points to ElastosJS contract
    this.ephemeralInstance = null

    this.databaseContractABI = ELAJSStoreJSON.abi
    this.databaseContractBytecode = ELAJSStoreJSON.bytecode

    this.config = {
      gasPrice: '1000000000',
      gasLimit: 8000000
    }

    this.debug = options.debug || false

    // TODO: we want to cache or use a Map, how to handle invalidating cache?
    // current idea is to save a block height with each schema update, all queries
    // that depend on the schema could pass in the last seen block height (version)
    // this.cache = {}

    this._initialize()
  }


  /*
   ******************************************************************************************************
   * Query Functions
   ******************************************************************************************************
   */
  async getTables(){
    return await this.ephemeralInstance.methods.getTables().call()
  }

  /**
   * TODO: Returns a chainable select object, that finally resolves to a callable Promise
   */
  select(){

    // return this? - need to instantiate and return a new Class instance for chaining

    // pass a reference to elajs into the constructor?
  }

  /**
   * @param tableName
   * @param id
   * @returns {Promise<void>}
   */
  async getRow(tableName, id){

    const tableKey = namehash(tableName)

    const tableSchema = await this.ephemeralInstance.methods.getSchema(tableKey).call()

    const colsPromises = tableSchema.columns.map((colData) => {

      const fieldName = Web3.utils.hexToString(colData.name)
      const fieldType = Web3.utils.hexToString(colData._dtype)

      return (async () => {
        let val = await this.getVal(tableName, id, fieldName, fieldType)

        return {
          name: fieldName,
          type: Web3.utils.hexToString(colData._dtype),
          value: val
        }
      })()
    })

    return Promise.all(colsPromises)
  }

  /**
   * The storage smart contract does not support auto_increment ids, therefore we
   * always generate randomBytes
   *
   * EPHEMERAL ONLY - TODO add ethAddress!
   *
   * TODO: we really want to return a Promise immediately, which resolves to all the inserts
   *
   * There are 3 types of tables
   * 1 = private, must be FORTMATIC signer and only works if it's the owner
   * 2 = public, can be any signer
   * 3 = shared, can be any signer
   *
   * @param tableName
   * @param cols Array of column names as STRINGS, name must be 32 chars or less
   * @param values - Array of values "as-is", we convert to bytes32 strings here
   * @param options - struct
   * @param options.signer
   *
   * @return the bytes32 id for the row
   */
  async insertRow(tableName, cols, values, options){

    const _defaultOptions = {}
    const colsLen = cols.length

    options = Object.assign(_defaultOptions, options)

    if (options.id && (options.id.substring(0, 2) !== '0x' || options.id.length !== 66)){
      throw new Error('options.id must be a 32 byte hex string prefixed with 0x')
    }

    if (colsLen !== values.length){
      throw new Error('cols, values arrays must be same length')
    }

    let id = Web3.utils.randomHex(32)

    if (options.id){
      id = options.id
    }

    const {idKey, tableKey} = this._getKeys(tableName, id.substring(2))

    // Be lazy for now and always check? TODO: add caching, or let it passed in?
    const schema = await this.getTableSchema(tableName)

    // create a map of col name to type
    const colTypeMap = new Map()
    schema.columns.map((colData) => {

      const colNameStr = Web3.utils.hexToString(colData.name)
      const colType = Web3.utils.hexToString(colData._dtype)

      colTypeMap.set(colNameStr, colType)
    })

    let instance, ethAddress
    if (options.ethAddress){
      instance = this.defaultInstance
      ethAddress = options.ethAddress
    } else {
      instance = this.ephemeralInstance
      ethAddress = this.ephemeralWeb3.accounts[0]
    }

    // TODO: parallel inserts with nonces
    for (let i = 0; i < colsLen; i++){

      let fieldKey = keccak256(cols[i])

      const val = this.constructor.castType(colTypeMap.get(cols[i]), values[i])

      await instance.methods.insertVal(
        tableKey,
        idKey,
        fieldKey,
        id,
        val, // we always insert bytes32 strings
      ).send({
        from: ethAddress
      })

    }

    return id
  }

  /**
   * Non-async - returns a promise so you have more granular control over progress display on the client
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

    if (options && options.id && (options.id.substring(0, 2) !== '0x' || options.id.length !== 66)){
      throw new Error('options.id must be a 32 byte hex string prefixed with 0x')
    }

    let id = Web3.utils.randomHex(32)

    if (options && options.id){
      id = options.id
    }

    const {idKey, tableKey} = this._getKeys(tableName, id.substring(2))
    const fieldKey = keccak256(col)

    return this.ephemeralInstance.methods.insertVal(
      tableKey,
      idKey,
      fieldKey,
      id,
      val
    ).send({
      from: this.ephemeralWeb3.accounts[0]
    })
  }

  deleteRow(){

  }

  /**
   * like _getVal but async and uses fieldType, which is from the schema
   */
  async getVal(tableName, id, fieldName, fieldType){

    let val = await this._getVal(tableName, id, fieldName)

    // TODO: type parsing? Can't if we return a promise, how to ensure this is fresh?
    // and so what if it isn't? We can't really change a field type right?
    // const fieldType = this.schema[tableKey][fieldKey].type
    if (fieldType){
      switch (fieldType){

        case constants.FIELD_TYPE.UINT:
          val = Web3.utils.hexToNumber(val)
          break

        case constants.FIELD_TYPE.STRING:
          val = Web3.utils.hexToString(val)
          break

        case constants.FIELD_TYPE.BOOL:
          val = !!Web3.utils.hexToNumber(val)
          break
      }
    }

    return val
  }



  /*
  ************************************************************************************************************
  * Helpers - should not be called externally
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

  /**
   * Update a single val, should be called by another fn
   * @private
   */
  _updateVal(){

  }

  /**
   * This is a call so we can always use ephemeral, has no type handling since this returns a promise
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

    return this.ephemeralInstance.methods.getRowValue(fieldIdTableKey).call()

  }

  /**
   * We should setup the web3 components if not passed in
   * @private
   */
  _initialize(){

    if (this.defaultWeb3 && this.databaseContractAddr){
      this.defaultInstance = new this.defaultWeb3.eth.Contract(this.databaseContractABI, this.databaseContractAddr)
    }

    if (this.ephemeralWeb3 && this.databaseContractAddr){
      this.ephemeralInstance = new this.ephemeralWeb3.lib.eth.Contract(this.databaseContractABI, this.databaseContractAddr)
    }

    // 1. fetch table list
    // 2. lazy fetch schema?
  }


  /*
  ************************************************************************************************************
  * Relay Hub
  ************************************************************************************************************
   */
  async getGSNBalance(){
    return await this.ephemeralInstance.methods.getGSNBalance().call()
  }

  /**
   * @param fromAddress ethAddress to send funds from, should correspond to the defaultWeb3 instance
   * @param contractAddress
   * @param amount to add in Ether
   */
  addFunds(fromAddress, contractAddress, amount){

    const relayHubAddress = this.relayHubAddr

    const relayHubInstance = new this.defaultWeb3.eth.Contract(relayHubData.abi, relayHubAddress, {
      data: relayHubData.bytecode
    })

    const amtInWei = new Web3.utils.BN(Web3.utils.toWei(amount, 'ether'))

    return relayHubInstance.methods.depositFor(contractAddress).send({
      useGSN: false,
      value: amtInWei,
      from: fromAddress
    })

  }

  /**
   *
   * @param destAddress keep this the same as fromAddress, so user can only withdraw to their own address
   */
  withdrawAll(destAddress){
    return this.defaultInstance.methods.withdrawAll(destAddress).send({
      useGSN: false,
      from: destAddress
    })
  }


  /*
  ************************************************************************************************************
  * Administrative - Changing Contracts, Deploying/Initializing
  ************************************************************************************************************
   */

  /**
   * It is very important that on additional/secondary ela-js instances that you call:
   *
   * await ethConfig.elajsUser.defaultWeb3.currentProvider.baseProvider.enable()
   *
   * This initializes the fortmatic web3 provider to sign transactions, but we won't do this
   * too presumptively since they may not be using Fortmatic
   *
   * TODO: we should possibly check if defaultInstance is formatic or Metamask at least (least not ephemeral)
   *
   * @param databaseContractAddr
   */
  setDatabase(databaseContractAddr){
    this.databaseContractAddr = databaseContractAddr
    this.defaultInstance = new this.defaultWeb3.eth.Contract(this.databaseContractABI, databaseContractAddr)
    this.ephemeralInstance = new this.ephemeralWeb3.lib.eth.Contract(this.databaseContractABI, databaseContractAddr)
  }

  /**
   * TODO: revisit if we should be passing ethAddress, this is all client-side anyway though
   * @param ethAddress
   */
  deployDatabase(ethAddress){
    const newContract = new this.defaultWeb3.eth.Contract(this.databaseContractABI)

    /*
    let fromAccount

    if (this.defaultWeb3.currentProvider &&
      this.defaultWeb3.currentProvider.baseProvider &&
      this.defaultWeb3.currentProvider.baseProvider.isFortmatic)
    {
      const ethAccounts = await this.defaultWeb3.eth.getAccounts()

      fromAccount = ethAccounts[0]
    } else {
      fromAccount = this.defaultWeb3.eth.personal.currentProvider.addresses[0]
    }
     */

    return newContract.deploy({
      data: this.databaseContractBytecode
    }).send({
      useGSN: false,
      from: ethAddress,
      gasPrice: this.config.gasPrice
    })
  }

  /**
   * Initialize newly deployed contract, must be called to retrieve GSN Balance
   *
   * @param ethAddress - from address which will pay for this non-GSN transaction
   */
  initializeContract(ethAddress){

    if (!this.relayHubAddr){
      throw new Error('Missing relayHub address')
    }

    // console.log(ethAddress, this.defaultInstance)

    return this.defaultInstance.methods.initialize(
      this.relayHubAddr
    ).send({
      useGSN: false,
      from: ethAddress,
      gasPrice: this.config.gasPrice,
      gasLimit: 250000
    })
  }

  /*
  ************************************************************************************************************
  * Schema - Create, Update, Remove Table
  ************************************************************************************************************
   */

  /**
   * fm call only
   *
   * we pass in ethAddress because we don't wait to wait for a fortmatic async fetch for ethAccounts
   *
   * @param tableName
   * @param permission - INT 1, 2, or 3
   * @param cols - array of BYTES32 Strings TODO: change this
   * @param colTypes - array of BYTES32 Strings TODO: change this
   * @param ethAddress
   * @returns {*}
   */
  createTable(tableName, permission, cols, colTypes, ethAddress){

    if (check.not.inRange(permission, 1, 3)){
      throw new Error(`createTable - permission value "${permission}" wrong`)
    }

    const tableNameValue = Web3.utils.stringToHex(tableName)
    const tableKey = namehash(tableName)

    if (cols.length !== colTypes.length) {
      throw new Error('cols and colTypes array length mismatch')
    }

    const colsBytes32 = cols.map(Web3.utils.stringToHex)
    const colTypesBytes32 = colTypes.map(Web3.utils.stringToHex)

    return this.defaultInstance.methods.createTable(
      tableNameValue,
      tableKey,
      permission,
      colsBytes32,
      colTypesBytes32
    ).send({
      useGSN: false,
      from: ethAddress || this.defaultWeb3.eth.personal.currentProvider.addresses[0],
      gasPrice: this.config.gasPrice,
      gas: 1500000
    })
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
   * Known types are:
   * - BYTES32
   * - STRING
   * - UINT
   * - BOOL
   *
   * @param colType
   * @param val
   *
   * @return bytes32 string
   */
  static castType(colType, val){

    this.checkType(colType, val)

    switch (colType){

      // we don't really expect to do anything for BYTES32,
      // just make sure it's a bytes32 string
      case constants.FIELD_TYPE.BYTES32:
        return val

      case constants.FIELD_TYPE.UINT:
        return uintToBytes32(val)

      case constants.FIELD_TYPE.STRING:
        return Web3.utils.stringToHex(val)

      case constants.FIELD_TYPE.BOOL:
        return uintToBytes32(val ? 1 : 0)

      default:
        throw new Error(`colType: "${colType}" not recognized`)
    }

  }

  /**
   * Known types are:
   * - BYTES32
   * - STRING
   * - UINT
   * - BOOL
   *
   * @param colType
   * @param val
   */
  static checkType(colType, val){

    switch (colType){

      // we expect
      case constants.FIELD_TYPE.BYTES32:
        if (check.not.string(val)){
          throw new Error('BYTES32 expects a string starting with 0x')
        }

        if (val.length !== 66){
          throw new Error('BYTES32 expects a string with length 66')
        }
        break

      case constants.FIELD_TYPE.UINT:
        if (check.not.integer(val) || check.not.greaterOrEqual(val, 0)){
          throw new Error('UINT expects 0 or positive integers')
        }
        break

      case constants.FIELD_TYPE.STRING:
        if (check.not.string(val)){
          throw new Error('STRING expects a string')
        }

        if (check.not.lessOrEqual(val.length, 32)){
          throw new Error('STRING max chars is 32')
        }
        break

      case constants.FIELD_TYPE.BOOL:
        if (check.not.boolean(val)){
          throw new Error('BOOL expects a boolean')
        }
        break

      default:
        throw new Error(`colType: "${colType}" not recognized`)
    }

    return true
  }
}
