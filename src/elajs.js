
import { keccak256 } from './keccak256'
import { namehash } from './namehash'
import Web3 from 'web3'

import config from './config'
import constants from './constants'

import relayHubData from './relay-hub/data'

import ELAJSStoreJSON from './contracts/ELAJSStore.json'

/**
 * Under Development
 *
 * TODO: consistent returns of promise
 * - Must support ephemeral (anonymous calls)
 * - Needs to have a way to connect to Fortmatic
 * - We always expect the parent app to pass in the ozWeb3 and fmWeb3?
 * - do we track state and an entire table schema? cached?
 * - web3 should definitely be external, we pass it in and instantiate the contract
 */
class ELA_JS {

  /**
   *
   * @param options
   */
  constructor(options){

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

    this.network = options.network || constants.NETWORK.LOCAL

    /*
    ************************************************************************************************************
    * Internal
    ************************************************************************************************************
     */

    // default instance - points to ElastosJS contract
    this.defaultInstance = null

    // ephemeral instance - points to ElastosJS contract
    this.ephemeralInstance = null

    this.ozWeb3 = null
    this.fmWeb3 = null

    this.schema = {}

    this.contractABI = ELAJSStoreJSON.abi
    this.contractBytecode = ELAJSStoreJSON.bytecode

    this.config = {
      gasPrice: '1000000000'
    }

    this.debug = options.debug || false

    // TODO: we want to cache or use a Map, how to handle invalidating cache
    this.cache = {}

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
   * Returns a chainable select object, that finally resolves to a callable Promise
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
   * @param cols Array of column names, name must be 32 chars or less
   * @param values - TODO: get the schema (cached) if possible to do the conversion here
   * @param options - struct
   * @param options.signer
   *
   * @return the bytes32 id for the row
   */
  async insertRow(tableName, cols, values, options){

    const _defaultOptions = {}

    options = Object.assign(_defaultOptions, options)

    if (options.id && (options.id.substring(0, 2) !== '0x' || options.id.length !== 66)){
      throw new Error('options.id must be a 32 byte hex string prefixed with 0x')
    }

    if (cols.length !== values.length){
      throw new Error('cols, values arrays must be same length')
    }

    let id = Web3.utils.randomHex(32)

    if (options.id){
      id = options.id
    }

    const {idKey, tableKey} = this._getKeys(tableName, id.substring(2))

    // TODO: check cache for table schema? Be lazy for now and always check?

    let instance, ethAddress
    if (options.ethAddress){
      instance = this.defaultInstance
      ethAddress = options.ethAddress
    } else {
      instance = this.ephemeralInstance
      ethAddress = this.ephemeralWeb3.accounts[0]
    }

    for (let i = 0; i < cols.length; i++){

      let fieldIdTableKey = namehash(`${cols[i]}.${id.substring(2)}.${tableName}`)
      this.debug && console.log(`fieldIdTableKey = ${fieldIdTableKey}`)
      let fieldKey = keccak256(cols[i])

      /*
      console.log(tableKey,
        idKey,
        fieldKey,
        id,
        values[i],
        ethAddress
      )
       */

      await instance.methods.insertVal(
        tableKey,
        idKey,
        fieldKey,
        id,
        values[i]
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
    const fieldIdTableKey = namehash(`${col}.${id.substring(2)}.${tableName}`)
    console.log(`fieldIdTableKey = ${fieldIdTableKey}`)
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

  // like _getVal but async and uses fieldType
  async getVal(tableName, id, fieldName, fieldType){

    if (id.substring(0, 2) !== '0x' || id.length !== 66){
      throw new Error('id must be a 32 byte hex string prefixed with 0x')
    }

    // always strip the 0x
    id = id.substring(2)

    const fieldIdTableKey = namehash(`${fieldName}.${id}.${tableName}`)

    let val = await this.ephemeralInstance.methods.getRowValue(fieldIdTableKey).call()

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

    // TODO: type parsing? Can't if we return a promise, how to ensure this is fresh?
    // and so what if it isn't? We can't really change a field type right?
    // const fieldType = this.schema[tableKey][fieldKey].type

  }

  /**
   * We should setup the web3 components if not passed in
   * @private
   */
  _initialize(){

    if (this.defaultWeb3 && this.contractAddress){
      this.defaultInstance = new this.defaultWeb3.eth.Contract(this.contractABI, this.contractAddress)
    }

    if (this.ephemeralWeb3 && this.contractAddress){
      // the ozWeb3 is constructed slightly differently
      this.ephemeralInstance = new this.ephemeralWeb3.lib.eth.Contract(this.contractABI, this.contractAddress)
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

    const relayHubAddress = config[this.network].relayHubAddress

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
   * This initializes the fortmatic web3 provider to sign transactions
   *
   * TODO: we should possibly check if defaultInstance is formatic or Metamask at least (least not ephemeral)
   *
   * @param contractAddress
   */
  setDatabase(contractAddress){
    this.contractAddress = contractAddress
    this.defaultInstance = new this.defaultWeb3.eth.Contract(this.contractABI, contractAddress)
    this.ephemeralInstance = new this.ephemeralWeb3.lib.eth.Contract(this.contractABI, contractAddress)
  }

  /**
   * TODO: revisit if we should be passing ethAddress, this is all client-side anyway though
   * @param ethAddress
   */
  deployDatabase(ethAddress){
    const newContract = new this.defaultWeb3.eth.Contract(this.contractABI)

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
      data: this.contractBytecode
    }).send({
      useGSN: false,
      from: ethAddress,
      gasPrice: this.config.gasPrice
    })
  }

  /**
   * Initialize newly deployed contract, must be called to retrieve GSN Balance
   *
   * @param ethAddress
   * @param relayHubAddr
   * @param dateTimeAddr
   */
  initializeContract(ethAddress, relayHubAddr, dateTimeAddr){

    console.log(ethAddress, this.defaultInstance)

    return this.defaultInstance.methods.initialize(relayHubAddr, dateTimeAddr).send({
      useGSN: false,
      from: ethAddress,
      gasPrice: this.config.gasPrice
    })
  }

  /*
  ************************************************************************************************************
  * Schema - Create, Update, Remove Table
  ************************************************************************************************************
   */

  // fm call only
  // we pass in ethAddress because we don't wait to wait for a fortmatic async fetch for ethAccounts
  createTable(tableName, permission, cols, colTypes, ethAddress){

    const tableNameValue = Web3.utils.stringToHex(tableName)
    const tableKey = namehash(tableName)

    if (cols.length !== colTypes.length) {
      throw new Error('cols and colTypes array length mismatch')
    }


    if (this.debug){
      console.log('createTable', tableKey)
      console.log(tableNameValue)
      console.log('cols', cols)
      console.log('colTypes', colTypes)

      // this should only work locally, fortmatic would use a different path
      console.log(ethAddress || this.defaultWeb3.eth.personal.currentProvider.addresses[0])

      console.log('gasPrice', this.config.gasPrice)
    }

    return this.defaultInstance.methods.createTable(
      tableNameValue,
      tableKey,
      permission,
      cols,
      colTypes
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

}

export default ELA_JS
