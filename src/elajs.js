import database from './database'

/**
 * Under Development
 *
 * TODO: consistent returns of promise
 * - Must support ephemeral (anonymous calls)
 * - Needs to have a way to connect to Fortmatic
 * - We always expect the parent app to pass in the ozWeb3 and fmWeb3?
 * - do we track state and an entire table schema? cached?
 * - web3 should definitely be external, we pass it in and instantiate the contract
 *
 * Design Principles
 * -  elajs should not know about which network it's connected to, the web3 providers
 *    are all passed in. The developer is responsible for setting the contract addresses
 *    associated with their network as well.
 */
const elajs = {
  database: database,
}

export default elajs
