

/**
 * - Must support ephemeral (anonymous calls)
 * - Needs to have a way to connect to Fortmatic
 * - Do we expect the parent app to pass in the ozWeb3 and fmWeb3?
 * - do we track state and an entire table schema? cached?
 */
class elajs {

  rpcUrl = 'test'

  /**
   *
   */
  constructor(options){
    console.log('constructor')

    this.contractAddress = options.contractAddress

    this.ozWeb3 = null
    this.fmWeb3 = null

    _initialize()
  }

  /**
   * We should setup the web3 components if not passed in
   * @private
   */
  _initialize(){

    if (oz.init === false){
      // TODO: setup oz
    }

    if (fm.init === false){
      // TODO: setup fm
    }
  }

  // fm call only
  createTable(){

  }

  insertRow(){
    // check id

    // check cache for table schema? Be lazy for now and always check?
  }

  /**
   * Update a single val, should be called by another fn
   * @private
   */
  _updateVal(){

  }

  deleteRow(){

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

export default elajs
