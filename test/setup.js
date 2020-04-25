/*
***************************************************************************************************
* This is used to deploy the smart contracts to an existing local blockchain for the test
*
* Steps YOU need to prepare are:
* 1.  For the env/[NODE_ENV].env file - set DEPLOY_CONTRACTS=true or false
* 2.  For the env/[NODE_ENV].env file - set MNEMONIC=(mnemonic from your ganache)
*     - you can automate it by using `grep -oP '^Mnemonic:\s+\K(.*)$' log.out` for example
*       and using a `sed` replace to update the .env file
* 3.  Same as above set DEFAULT_WALLET
*
* Things to note:
* 1.  This setup script will replace the env file's DATETIME_CONTRACT_ADDR and
*     ELAJSSTORE_CONTRACT_ADDR values with the latest deploy
* 2.  env file's RELAY_HUB_ADDR is network dependent and should be set properly already
***************************************************************************************************
 */

// TODO
