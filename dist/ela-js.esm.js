import _defineProperty from '@babel/runtime/helpers/defineProperty';
import _ from 'lodash';
import _regeneratorRuntime from '@babel/runtime/regenerator';
import _asyncToGenerator from '@babel/runtime/helpers/asyncToGenerator';
import _classCallCheck from '@babel/runtime/helpers/classCallCheck';
import _createClass from '@babel/runtime/helpers/createClass';
import Web3 from 'web3';

var bytes32ToStr = function bytes32ToStr(buf) {
  return _.trimStart(buf.toString(), "\0");
};

var bytes32ToUint = function bytes32ToUint(buf) {
  var buf4 = new Buffer.alloc(4);
  buf.copy(buf4, 0, 28);
  return parseInt(buf4.readUInt32BE().toString(10));
};

var bytesToTypes = {
  bytes32ToStr: bytes32ToStr,
  bytes32ToUint: bytes32ToUint
};

// not really needed - use Web3.utils.stringToHex
var strToBytes32 = function strToBytes32(input) {
  var targetBuf = new Buffer.alloc(32);
  var inputBuf = new Buffer.from(input);
  var inputByteLen = inputBuf.byteLength; // overflow isn't written

  inputBuf.copy(targetBuf, inputByteLen < 32 ? 32 - inputByteLen : 0);
  return targetBuf;
};

var uintToBytes32 = function uintToBytes32(input) {
  var inputBuf = new Buffer.alloc(4);
  inputBuf.writeUInt32BE(input);
  var targetBuf = new Buffer.alloc(32);
  inputBuf.copy(targetBuf, 28);
  return targetBuf;
};

var typesToBytes = {
  strToBytes32: strToBytes32,
  uintToBytes32: uintToBytes32
};

var _require = require('sha3'),
    Keccak = _require.Keccak;

var sha3 = new Keccak(256);

function namehashInner(input) {
  if (input === '') {
    return new Buffer.alloc(32);
  }

  var inputSplit = input.split('.');
  var label = inputSplit.shift();
  var remainder = inputSplit.join('.');
  var labelSha3 = sha3.update(label).digest(); // console.log(labelSha3.toString('hex'))

  sha3.reset();
  var iter = sha3.update(Buffer.concat([namehashInner(remainder), labelSha3])).digest();
  sha3.reset(); // TODO: figure out why this needs to be here

  return iter;
}

function namehash(input) {
  return '0x' + namehashInner(input).toString('hex');
}
 // 0000000000000000000000000000000000000000000000000000000000000000

var _require$1 = require('sha3'),
    Keccak$1 = _require$1.Keccak;

var sha3$1 = new Keccak$1(256);

function keccak256(input) {
  if (input.substring(0, 2) === '0x') {
    input = Buffer.from(input.substring(2), 'hex');
  }

  sha3$1.reset();
  var hash = sha3$1.update(input).digest();
  return '0x' + hash.toString('hex');
}

var fileName = "ELAJSStore.sol";
var contractName = "ELAJSStore";
var source = "pragma solidity ^0.5.0;\npragma experimental ABIEncoderV2;\n\nimport \"sol-datastructs/src/contracts/PolymorphicDictionaryLib.sol\";\n\n// import \"sol-datastructs/src/contracts/Bytes32DictionaryLib.sol\";\nimport \"sol-datastructs/src/contracts/Bytes32SetDictionaryLib.sol\";\n\n// import \"./oz/EnumerableSetDictionary.sol\";\n\nimport \"sol-sql/src/contracts/src/structs/TableLib.sol\";\n\nimport \"./ozEla/OwnableELA.sol\";\nimport \"./gsnEla/GSNRecipientELA.sol\";\nimport \"./gsnEla/IRelayHubELA.sol\";\n\ncontract DateTime {\n    function getYear(uint timestamp) public pure returns (uint16);\n    function getMonth(uint timestamp) public pure returns (uint8);\n    function getDay(uint timestamp) public pure returns (uint8);\n}\n\n// TODO: good practice to have functions not callable externally and internally\ncontract ELAJSStore is OwnableELA, GSNRecipientELA {\n\n    // TODO: have a dynamic mode to only use Events -> https://thegraph.com\n    // bool public useEvents = false;\n\n    // DateTime Contract address\n    address public dateTimeAddr = 0xe982E462b094850F12AF94d21D470e21bE9D0E9C; // development\n    // address constant public dateTimeAddr = 0xEDb211a2dBbdE62012440177e65b68E0A66E4531; // testnet\n\n    // Initialize the DateTime contract ABI with the already deployed contract\n    DateTime dateTime = DateTime(dateTimeAddr);\n\n    // This counts the number of times this contract was called via GSN (expended owner gas) for rate limiting\n    // mapping is a keccak256('YYYY-MM-DD') => uint (TODO: we can probably compress this by week (4 bytes per day -> 28 bytes)\n    mapping(bytes32 => uint256) public gsnCounter;\n\n    // Max times we allow this to be called per day\n    uint40 public gsnMaxCallsPerDay;\n\n    using PolymorphicDictionaryLib for PolymorphicDictionaryLib.PolymorphicDictionary;\n    using Bytes32SetDictionaryLib for Bytes32SetDictionaryLib.Bytes32SetDictionary;\n\n    // _table = system table (bytes32 Dict) of each table's metadata marshaled\n    // 8 bits - permissions (00 = system, 01 = private, 10 = public, 11 = shared - owner can always edit)\n    // 20 bytes - address delegate - other address allowed to edit\n    mapping(bytes32 => bytes32) internal _table;\n\n    // table = dict, where the key is the table, and the value is a set of byte32 ids\n    Bytes32SetDictionaryLib.Bytes32SetDictionary internal tableId;\n\n    // Schema dictionary, key (schemasPublicTables) points to a set of table names\n    using TableLib for TableLib.Table;\n    using TableLib for bytes;\n    // using ColumnLib for ColumnLib.Column;\n    // using ColumnLib for bytes;\n\n    // schemaTables -> Set of tables (raw table name values) for enumeration\n    bytes32 constant public schemasTables = 0x736368656d61732e7075626c69632e7461626c65730000000000000000000000;\n\n    // namehash([tableName]) => encoded table schema\n    // ownership of each row (id) - key = namehash([id].[table]) which has a value that is the owner's address\n    // ultimately namehash([field].[id].[table]) gives us a bytes32 which maps to the single data value\n    PolymorphicDictionaryLib.PolymorphicDictionary internal database;\n\n\n    // ************************************* SETUP FUNCTIONS *************************************\n    function initialize() public initializer {\n        OwnableELA.initialize(msg.sender);\n        GSNRecipientELA.initialize();\n        _initialize();\n    }\n\n    function _initialize() internal {\n        gsnMaxCallsPerDay = 1000;\n\n        // init the key for schemasTables, our set is one-to-many-fixed, so table names must be max 32 bytes\n        database.addKey(schemasTables, PolymorphicDictionaryLib.DictionaryType.OneToManyFixed);\n    }\n\n    // ************************************* SCHEMA FUNCTIONS *************************************\n    /**\n     * @dev create a new table, only the owner may create this\n     *\n     * @param tableName right padded zeroes (Web3.utils.stringToHex)\n     * @param tableKey this is the namehash of tableName\n     */\n    function createTable(\n        bytes32 tableName,\n        bytes32 tableKey,\n        uint8 permission,\n        bytes32[] memory _columnName,\n        bytes32[] memory _columnDtype\n\n    ) public onlyOwner {\n\n        // this only works if tableName is trimmed of padding zeroes, since this is an onlyOwner call we won't bother\n        // require(isNamehashSubOf(keccak256(tableNameBytes), bytes32(0), tableKey), \"tableName does not match tableKey\");\n\n        // check if table exists\n        require(_table[tableKey] == 0, \"Table already exists\");\n\n        address delegate = address(0x0);\n\n        // claim the key slot and set the metadata\n        setTableMetadata(tableKey, permission, delegate);\n\n        database.addValueForKey(schemasTables, tableName);\n\n        // table stores the row ids set as the value, set up the key\n        tableId.addKey(tableKey);\n\n        // now insert the schema\n        TableLib.Table memory tableSchema = TableLib.create(\n            tableName,\n            _columnName,\n            _columnDtype\n        );\n\n        saveSchema(tableKey, tableSchema);\n    }\n\n    // TODO: this isn't complete\n    function deleteTable(\n        bytes32 tableName,\n        bytes32 tableKey\n    ) public onlyOwner {\n        _table[tableKey] = 0;\n        database.removeValueForKey(schemasTables, tableName);\n        tableId.removeKey(tableKey);\n    }\n\n    function getTables() external view returns (bytes32[] memory){\n        return database.enumerateForKeyOneToManyFixed(schemasTables);\n    }\n\n    /*\n    function tableExists(bytes32 tableKey) public view returns (bool) {\n        return tableId.containsKey(tableKey);\n    }\n    */\n\n    function saveSchema(bytes32 tableKey, TableLib.Table memory tableSchema) internal returns (bool) {\n        bytes memory encoded = tableSchema.encode();\n\n        // we store the encoded table schema on the base tableKey\n        return database.setValueForKey(tableKey, encoded);\n    }\n\n    // EXPERIMENTAL\n    function getSchema(bytes32 _name) public view returns (TableLib.Table memory) {\n        bytes memory encoded = database.getBytesForKey(_name);\n        return encoded.decodeTable();\n    }\n\n    // ************************************* CRUD FUNCTIONS *************************************\n\n    /**\n     * @dev Table level permission checks\n     */\n    modifier insertCheck(bytes32 tableKey) {\n\n        (uint256 permission, address delegate) = getTableMetadata(tableKey);\n\n        // if permission = 0, system table we can't do anything\n        require(permission > 0, \"Cannot INSERT into system table\");\n\n        // if permission = 1, we must be the owner/delegate\n        require(permission > 1 || isOwner() == true || delegate == _msgSender(), \"Only owner/delegate can INSERT into this table\");\n\n        _;\n    }\n\n    /*\n    event InsertVal (\n        bytes32 indexed fieldIdTableKey,\n        address indexed owner,\n        bytes32 val\n    );\n    */\n\n    /**\n     * @dev Prior to insert, we check the permissions and autoIncrement\n     * TODO: use the schema and determine the proper type of data to insert\n     *\n     * @param tableKey the namehashed [table] name string\n     * @param idKey the sha3 hashed idKey\n     * @param id as the raw string (unhashed)\n     */\n    function insertVal(\n\n        bytes32 tableKey,\n        bytes32 idKey,\n        bytes32 fieldKey,\n\n        bytes32 id,\n        bytes32 val)\n\n    public insertCheck(tableKey){\n\n        bytes32 idTableKey = namehash(idKey, tableKey);\n        bytes32 fieldIdTableKey = namehash(fieldKey, idTableKey);\n\n        require(database.containsKey(fieldIdTableKey) == false, \"id+field already exists\");\n\n        // increment counter\n        increaseGsnCounter();\n\n        // add an id entry to the table's set of ids for the row (this is a set so we don't need to check first)\n        // TODO: should we check the id/row ownership?\n        tableId.addValueForKey(tableKey, id);\n\n        // add the \"row owner\" if it doesn't exist, the row may already exist in which case we don't update it\n        if (database.containsKey(idTableKey) == false){\n            _setRowOwner(idTableKey, id, tableKey);\n        }\n\n        // finally set the data\n        // we won't serialize the type, that's way too much redundant data\n        database.setValueForKey(fieldIdTableKey, bytes32(val));\n\n        // emit InsertVal(fieldIdTableKey, _msgSender(), val);\n\n    }\n\n    function insertValVar(\n        bytes32 tableKey,\n        bytes32 idKey,\n        bytes32 fieldKey,\n\n        bytes32 id,\n        bytes memory val)\n\n    public insertCheck(tableKey){\n\n        bytes32 idTableKey = namehash(idKey, tableKey);\n        bytes32 fieldIdTableKey = namehash(fieldKey, idTableKey);\n\n        require(database.containsKey(fieldIdTableKey) == false, \"id+field already exists\");\n\n        // increment counter\n        increaseGsnCounter();\n\n        // add an id entry to the table's set of ids for the row\n        tableId.addValueForKey(tableKey, id);\n\n        // add the \"row owner\" if it doesn't exist, the row may already exist in which case we don't update it\n        if (database.containsKey(idTableKey) == false){\n            _setRowOwner(idTableKey, id, tableKey);\n        }\n\n        // finally set the data\n        database.setValueForKey(fieldIdTableKey, val);\n    }\n\n    /**\n     * @dev we are essentially claiming this [id].[table] for the msg.sender, and setting the id createdDate\n     */\n    function _setRowOwner(bytes32 idTableKey, bytes32 id, bytes32 tableKey) internal {\n\n        require(database.containsKey(idTableKey) == false, \"row already has owner\");\n\n        uint256 rowMetadata;\n\n        uint16 year = dateTime.getYear(now);\n        uint8 month = dateTime.getMonth(now);\n        uint8 day = dateTime.getDay(now);\n\n        rowMetadata |= year;\n        rowMetadata |= uint256(month)<<16;\n        rowMetadata |= uint256(day)<<24;\n\n        bytes4 createdDate = bytes4(uint32(rowMetadata));\n\n        rowMetadata |= uint256(_msgSender())<<32;\n\n        database.setValueForKey(idTableKey, bytes32(rowMetadata));\n\n        emit InsertRow(id, tableKey, _msgSender());\n    }\n\n    event InsertRow (\n        bytes32 indexed _id,\n        bytes32 indexed _tableKey,\n        address indexed _rowOwner\n    );\n\n    function getRowOwner(bytes32 idTableKey) external returns (address rowOwner, bytes4 createdDate){\n\n        uint256 rowMetadata = uint256(database.getBytes32ForKey(idTableKey));\n\n        createdDate = bytes4(uint32(rowMetadata));\n        rowOwner = address(rowMetadata>>32);\n\n    }\n\n    function updateCheck(bytes32 tableKey, bytes32 idKey, bytes32 idTableKey, bytes32 id) internal {\n\n        require(tableId.containsValueForKey(tableKey, id) == true, \"id doesn't exist, use INSERT\");\n\n        (uint256 permission, address delegate) = getTableMetadata(tableKey);\n\n        // if permission = 0, system table we can't do anything\n        require(permission > 0, \"Cannot UPDATE system table\");\n\n        // if permission = 1, we must be the owner/delegate\n        require(permission > 1 || isOwner() == true || delegate == _msgSender(), \"Only owner/delegate can UPDATE into this table\");\n\n        // permissions check (public table = 2, shared table = 3),\n        // if 2 or 3 is the _msg.sender() the row owner? But if 3 owner() is always allowed\n        if (permission >= 2) {\n\n            // rowMetaData is packed as address (bytes20) + createdDate (bytes4)\n            bytes32 rowMetaData = database.getBytes32ForKey(idTableKey);\n            address rowOwner = address(uint256(rowMetaData)>>32);\n\n            // if either 2 or 3, if you're the row owner it's fine\n            if (rowOwner == _msgSender()){\n                // pass\n            } else {\n                require(isOwner() == true || delegate == _msgSender(), \"Not rowOwner or owner/delegate for UPDATE into this table\");\n            }\n        }\n    }\n\n    function updateVal(\n\n        bytes32 tableKey,\n        bytes32 idKey,\n        bytes32 fieldKey,\n\n        bytes32 id,\n        bytes32 val)\n\n    public {\n\n        bytes32 idTableKey = namehash(idKey, tableKey);\n        bytes32 fieldIdTableKey = namehash(fieldKey, idTableKey);\n\n        updateCheck(tableKey, idKey, idTableKey, id);\n\n        // increment counter\n        increaseGsnCounter();\n\n        // set data (overwrite)\n        database.setValueForKey(fieldIdTableKey, bytes32(val));\n\n    }\n\n    function deleteCheck(bytes32 tableKey, bytes32 idTableKey, bytes32 idKey, bytes32 id) internal {\n\n        require(tableId.containsValueForKey(tableKey, id) == true, \"id doesn't exist\");\n\n        (uint256 permission, address delegate) = getTableMetadata(tableKey);\n\n        // if permission = 0, system table we can't do anything\n        require(permission > 0, \"Cannot DELETE from system table\");\n\n        // if permission = 1, we must be the owner/delegate\n        require(permission > 1 || isOwner() == true || delegate == _msgSender(), \"Only owner/delegate can DELETE from this table\");\n\n        // permissions check (public table = 2, shared table = 3),\n        // if 2 or 3 is the _msg.sender() the row owner? But if 3 owner() is always allowed\n        if (permission >= 2) {\n            if (isOwner() || delegate == _msgSender()){\n                // pass\n            } else {\n                // rowMetaData is packed as address (bytes20) + createdDate (bytes4)\n                bytes32 rowMetaData = database.getBytes32ForKey(idTableKey);\n                address rowOwner = address(uint256(rowMetaData)>>32);\n                require(rowOwner == _msgSender(), \"Sender not owner of row\");\n            }\n        }\n    }\n\n    /**\n     * @dev TODO: add modifier checks based on update\n     *\n     * TODO: this needs to properly remove the row when there are multiple ids\n     *\n     */\n    function deleteVal(\n\n        bytes32 tableKey,\n        bytes32 idKey,\n        bytes32 fieldKey,\n\n        bytes32 id\n\n    ) public {\n\n        bytes32 idTableKey = namehash(idKey, tableKey);\n        bytes32 fieldIdTableKey = namehash(fieldKey, idTableKey);\n\n        deleteCheck(tableKey, idTableKey, idKey, id);\n\n        // increment counter\n        increaseGsnCounter();\n\n        // remove the key\n        bool removed = database.removeKey(fieldIdTableKey);\n\n        require(removed == true, \"error removing key\");\n\n        // TODO: zero out the data? Why bother everything is public\n\n        // we can't really pass in enough data to make a loop worthwhile\n        /*\n        uint8 len = uint8(fieldKeys.length);\n        require(fieldKeys.length == fieldIdTableKeys.length, \"fields, id array length mismatch\");\n        for (uint8 i = 0; i < len; i++) {\n\n            // for each row check if the full field + id + table is a subhash\n            // require(isNamehashSubOf(fieldKeys[i], idTableKey, fieldIdTableKeys[i]) == true, \"fieldKey not a subhash [field].[id].[table]\");\n\n            // zero out the data\n            elajsStore[fieldIdTableKeys[i]] = bytes32(0);\n        }\n        */\n    }\n\n    // TODO: improve this, we don't want to cause data consistency if the client doesn't call this\n    // Right now we manually call this, but ideally we iterate over all the data and delete each column\n    // but this would require decoding and having all the field names\n    function deleteRow(\n\n        bytes32 tableKey,\n        bytes32 idKey,\n        bytes32 id\n\n    ) public {\n\n        bytes32 idTableKey = namehash(idKey, tableKey);\n\n        deleteCheck(tableKey, idTableKey, idKey, id);\n\n        // increment counter\n        increaseGsnCounter();\n\n        // remove the id\n        tableId.removeValueForKey(tableKey, id);\n    }\n\n    /**\n     * @dev Table actual insert call, NOTE this doesn't work on testnet currently due to a stack size issue,\n     *      but it can work with a paid transaction I guess\n     */\n    /*\n    function insert(\n        bytes32 tableKey,\n        bytes32 idTableKey,\n\n        bytes32 idKey,\n        bytes32 id,\n\n        bytes32[] memory fieldKeys,\n        bytes32[] memory fieldIdTableKeys,\n        bytes32[] memory values)\n\n    public insertCheck(tableKey, idKey, idTableKey){\n\n        require(table.containsValueForKey(tableKey, id) == false, \"id already exists\");\n\n        uint len = fieldKeys.length;\n\n        require(fieldKeys.length == fieldIdTableKeys.length == values.length, \"fields, values array length mismatch\");\n\n        // add an id entry to the table's set of ids for the row\n        table.addValueForKey(tableKey, id);\n\n        for (uint i = 0; i < len; i++) {\n\n            // for each row check if the full field + id + table is a subhash\n            require(isNamehashSubOf(fieldKeys[i], idTableKey, fieldIdTableKeys[i]) == true, \"fieldKey not a subhash [field].[id].[table]\");\n\n            elajsStore[fieldIdTableKeys[i]] = bytes32(values[i]);\n        }\n\n    }\n    */\n\n    /*\n    function getAllDataKeys() external view returns (bytes32[] memory) {\n        return database.enumerate();\n    }\n    */\n\n    function checkDataKey(bytes32 key) external view returns (bool) {\n        return database.containsKey(key);\n    }\n\n    /**\n     * @dev all data is public, so no need for security checks, we leave the data type handling to the client\n     */\n    function getRowValue(bytes32 fieldIdTableKey) external view returns (bytes32) {\n\n        if (database.containsKey(fieldIdTableKey)) {\n            return database.getBytes32ForKey(fieldIdTableKey);\n        } else {\n            return bytes32(0);\n        }\n    }\n\n    function getRowValueVar(bytes32 fieldIdTableKey) external view returns (bytes memory) {\n\n        if (database.containsKey(fieldIdTableKey)) {\n            return database.getBytesForKey(fieldIdTableKey);\n        } else {\n            return new bytes(0);\n        }\n    }\n\n    /**\n     * @dev Warning this produces an Error: overflow (operation=\"setValue\", fault=\"overflow\", details=\"Number can only safely store up to 53 bits\")\n     *      if the table doesn't exist\n     */\n    function getTableIds(bytes32 tableKey) external view returns (bytes32[] memory){\n\n        require(tableId.containsKey(tableKey) == true, \"table not created\");\n\n        return tableId.enumerateForKey(tableKey);\n    }\n\n    function getIdExists(bytes32 tableKey, bytes32 id) external view returns (bool) {\n        return tableId.containsValueForKey(tableKey, id);\n    }\n\n    /*\n    function isNamehashSubOf(bytes32 subKey, bytes32 base, bytes32 target) internal pure returns (bool) {\n        bytes32 result = namehash(subKey, base);\n        return result == target;\n    }\n    */\n\n    function namehash(bytes32 subKey, bytes32 base) internal pure returns (bytes32) {\n        bytes memory concat = new bytes(64);\n\n        assembly {\n            mstore(add(concat, 64), subKey)\n            mstore(add(concat, 32), base)\n        }\n\n        bytes32 result = keccak256(concat);\n\n        return result;\n    }\n\n    // ************************************* _TABLE FUNCTIONS *************************************\n    function getTableMetadata(bytes32 _tableKey)\n        view\n        public\n        returns (uint256 permission, address delegate)\n    {\n        require(_table[_tableKey] > 0, \"table does not exist\");\n\n        uint256 tableMetadata = uint256(_table[_tableKey]);\n\n        permission = uint256(uint8(tableMetadata));\n        delegate = address(tableMetadata>>8);\n    }\n\n    function setTableMetadata(bytes32 _tableKey, uint8 permission, address delegate) private onlyOwner {\n        uint256 tableMetadata;\n\n        tableMetadata |= permission;\n        tableMetadata |= uint160(delegate)<<8;\n\n        _table[_tableKey] = bytes32(tableMetadata);\n    }\n\n    // ************************************* MISC FUNCTIONS *************************************\n\n    function() external payable {}\n\n    // ************************************* GSN FUNCTIONS *************************************\n\n    /**\n     * As a first layer of defense we employ a max number of checks per day\n     */\n    function acceptRelayedCall(\n        address relay,\n        address from,\n        bytes calldata encodedFunction,\n        uint256 transactionFee,\n        uint256 gasPrice,\n        uint256 gasLimit,\n        uint256 nonce,\n        bytes calldata approvalData,\n        uint256 maxPossibleCharge\n    ) external view returns (uint256, bytes memory) {\n\n        bytes32 curDateHashed = getGsnCounter();\n\n        // check gsnCounter for today and compare to limit\n        uint256 curCounter = gsnCounter[curDateHashed];\n\n        if (curCounter >= gsnMaxCallsPerDay){\n            return _rejectRelayedCall(2);\n        }\n\n\n        return _approveRelayedCall();\n    }\n\n    function setGsnMaxCallsPerDay(uint256 max) external onlyOwner {\n        gsnMaxCallsPerDay = uint40(max);\n    }\n\n    /*\n    event GsnCounterIncrease (\n        address indexed _from,\n        bytes4 indexed curDate\n    );\n    */\n\n    /**\n     * Increase the GSN Counter for today\n     */\n    function increaseGsnCounter() internal {\n\n        bytes32 curDateHashed = getGsnCounter();\n\n        uint256 curCounter = gsnCounter[curDateHashed];\n\n        gsnCounter[curDateHashed] = curCounter + 1;\n\n        // emit GsnCounterIncrease(_msgSender(), bytes4(uint32(curDate)));\n    }\n\n    /*\n     *\n     */\n    function getGsnCounter() internal view returns (bytes32 curDateHashed) {\n\n        uint256 curDate;\n\n        uint16 year = dateTime.getYear(now);\n        uint8 month = dateTime.getMonth(now);\n        uint8 day = dateTime.getDay(now);\n\n        curDate |= year;\n        curDate |= uint256(month)<<16;\n        curDate |= uint256(day)<<24;\n\n        curDateHashed = keccak256(abi.encodePacked(curDate));\n    }\n\n    // We won't do any pre or post processing, so leave _preRelayedCall and _postRelayedCall empty\n    function _preRelayedCall(bytes memory context) internal returns (bytes32) {\n    }\n\n    function _postRelayedCall(bytes memory context, bool, uint256 actualCharge, bytes32) internal {\n    }\n\n    /**\n     * @dev Withdraw a specific amount of the GSNReceipient funds\n     * @param amt Amount of wei to withdraw\n     * @param dest This is the arbitrary withdrawal destination address\n     */\n    function withdraw(uint256 amt, address payable dest) public onlyOwner {\n        IRelayHubELA relayHub = getRelayHub();\n        relayHub.withdraw(amt, dest);\n    }\n\n    /**\n     * @dev Withdraw all the GSNReceipient funds\n     * @param dest This is the arbitrary withdrawal destination address\n     */\n    function withdrawAll(address payable dest) public onlyOwner returns (uint256) {\n        IRelayHubELA relayHub = getRelayHub();\n        uint256 balance = getRelayHub().balanceOf(address(this));\n        relayHub.withdraw(balance, dest);\n        return balance;\n    }\n\n    function getGSNBalance() public view returns (uint256) {\n        return getRelayHub().balanceOf(address(this));\n    }\n\n    function getRelayHub() internal view returns (IRelayHubELA) {\n        return IRelayHubELA(_getRelayHub());\n    }\n}\n";
var sourcePath = "contracts/ELAJSStore.sol";
var sourceMap = "782:21962:2:-;;;1018:42;988:72;;;;;;;;;;;;;;;;;;;;1291:12;;;;;;;;;;;1262:42;;;;;;;;;;;;;;;;;;;;782:21962;;;;;;";
var deployedSourceMap = "782:21962:2:-;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;21932:162;;8:9:-1;5:2;;;30:1;27;20:12;5:2;21932:162:2;;;;;;;;;;;;;;;;;;;1653:31;;8:9:-1;5:2;;;30:1;27;20:12;5:2;1653:31:2;;;;;;;;;;;;;;;;;;;;16805:113;;8:9:-1;5:2;;;30:1;27;20:12;5:2;16805:113:2;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;5300:138;;8:9:-1;5:2;;;30:1;27;20:12;5:2;5300:138:2;;;;;;;;;;;;;;;;;;;;10143:280;;8:9:-1;5:2;;;30:1;27;20:12;5:2;10143:280:2;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;3935:1087;;8:9:-1;5:2;;;30:1;27;20:12;5:2;3935:1087:2;;;;;;;;;;;;;;;;;;;22507:117;;8:9:-1;5:2;;;30:1;27;20:12;5:2;22507:117:2;;;;;;;;;;;;;;;;;;;;8304:891;;8:9:-1;5:2;;;30:1;27;20:12;5:2;8304:891:2;;;;;;;;;;;;;;;;;;;2628:106;;8:9:-1;5:2;;;30:1;27;20:12;5:2;2628:106:2;;;;;;;;;;;;;;;;;;;;1549:45;;8:9:-1;5:2;;;30:1;27;20:12;5:2;1549:45:2;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;17050:260;;8:9:-1;5:2;;;30:1;27;20:12;5:2;17050:260:2;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;1724:137:17;;8:9:-1;5:2;;;30:1;27;20:12;5:2;1724:137:17;;;;;;589:90:8;;8:9:-1;5:2;;;30:1;27;20:12;5:2;589:90:8;;;;;;;;;;;;;;;;;;;;11762:493:2;;8:9:-1;5:2;;;30:1;27;20:12;5:2;11762:493:2;;;;;;;;;;;;;;;;;;;945:210:11;;8:9:-1;5:2;;;30:1;27;20:12;5:2;945:210:11;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;3180:152:2;;8:9:-1;5:2;;;30:1;27;20:12;5:2;3180:152:2;;;;;;15123:357;;8:9:-1;5:2;;;30:1;27;20:12;5:2;15123:357:2;;;;;;;;;;;;;;;;;;;19772:655;;8:9:-1;5:2;;;30:1;27;20:12;5:2;19772:655:2;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;13651:1193;;8:9:-1;5:2;;;30:1;27;20:12;5:2;13651:1193:2;;;;;;;;;;;;;;;;;;;937:77:17;;8:9:-1;5:2;;;30:1;27;20:12;5:2;937:77:17;;;;;;;;;;;;;;;;;;;;1288:92;;8:9:-1;5:2;;;30:1;27;20:12;5:2;1288:92:17;;;;;;;;;;;;;;;;;;;;5892:186:2;;8:9:-1;5:2;;;30:1;27;20:12;5:2;5892:186:2;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;793:227:8;;8:9:-1;5:2;;;30:1;27;20:12;5:2;793:227:8;;;;;;;;;;;;;;;;;;;;7162:1136:2;;8:9:-1;5:2;;;30:1;27;20:12;5:2;7162:1136:2;;;;;;;;;;;;;;;;;;;20433:110;;8:9:-1;5:2;;;30:1;27;20:12;5:2;20433:110:2;;;;;;;;;;;;;;;;;;;17793:215;;8:9:-1;5:2;;;30:1;27;20:12;5:2;17793:215:2;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;719:142:17;;8:9:-1;5:2;;;30:1;27;20:12;5:2;719:142:17;;;;;;;;;;;;;;;;;;;988:72:2;;8:9:-1;5:2;;;30:1;27;20:12;5:2;988:72:2;;;;;;;;;;;;;;;;;;;;18797:363;;8:9:-1;5:2;;;30:1;27;20:12;5:2;18797:363:2;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;1412:276:11;;8:9:-1;5:2;;;30:1;27;20:12;5:2;1412:276:11;;;;;;;;;;;;;;;;;;;17316:268:2;;8:9:-1;5:2;;;30:1;27;20:12;5:2;17316:268:2;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;5061:233;;8:9:-1;5:2;;;30:1;27;20:12;5:2;5061:233:2;;;;;;;;;;;;;;;;;;;18014:145;;8:9:-1;5:2;;;30:1;27;20:12;5:2;18014:145:2;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;2010:107:17;;8:9:-1;5:2;;;30:1;27;20:12;5:2;2010:107:17;;;;;;;;;;;;;;;;;;;22237:264:2;;8:9:-1;5:2;;;30:1;27;20:12;5:2;22237:264:2;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;21932:162;1141:9:17;:7;:9::i;:::-;1133:54;;;;;;;;;;;;;;;;;;;;;;;;22012:21:2;22036:13;:11;:13::i;:::-;22012:37;;22059:8;:17;;;22077:3;22082:4;22059:28;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;8:9:-1;5:2;;;30:1;27;20:12;5:2;22059:28:2;;;;8:9:-1;5:2;;;45:16;42:1;39;24:38;77:16;74:1;67:27;5:2;22059:28:2;;;;1197:1:17;21932:162:2;;:::o;1653:31::-;;;;;;;;;;;;;:::o;16805:113::-;16863:4;16886:25;16907:3;16886:8;:20;;:25;;;;:::i;:::-;16879:32;;16805:113;;;:::o;5300:138::-;5344:16;5378:53;2668:66;5417:13;;5378:8;:38;;:53;;;;:::i;:::-;5371:60;;5300:138;:::o;10143:280::-;10202:16;10220:18;10250:19;10280:37;10306:10;10280:8;:25;;:37;;;;:::i;:::-;10272:46;;;10250:68;;10357:11;10343:27;;10329:41;;10412:2;10399:11;:15;52:12:-1;49:1;45:20;29:14;25:41;7:59;;10399:15:2;10380:35;;10143:280;;;;:::o;3935:1087::-;1141:9:17;:7;:9::i;:::-;1133:54;;;;;;;;;;;;;;;;;;;;;;;;4450:1:2;4430:21;;:6;:16;4437:8;4430:16;;;;;;;;;;;;:21;4422:54;;;;;;;;;;;;;;;;;;;;;;;;4487:16;4514:3;4487:31;;4580:48;4597:8;4607:10;4619:8;4580:16;:48::i;:::-;4639:49;2668:66;4663:13;;4678:9;4639:8;:23;;:49;;;;;:::i;:::-;;4768:24;4783:8;4768:7;:14;;:24;;;;:::i;:::-;;4836:33;;:::i;:::-;4872:99;4901:9;4924:11;4949:12;4872:15;:99::i;:::-;4836:135;;4982:33;4993:8;5003:11;4982:10;:33::i;:::-;;1197:1:17;;3935:1087:2;;;;;:::o;22507:117::-;22553:7;22579:13;:11;:13::i;:::-;:23;;;22611:4;22579:38;;;;;;;;;;;;;;;;;;;;;;;;;;;;8:9:-1;5:2;;;30:1;27;20:12;5:2;22579:38:2;;;;8:9:-1;5:2;;;45:16;42:1;39;24:38;77:16;74:1;67:27;5:2;22579:38:2;;;;;;;101:4:-1;97:9;90:4;84;80:15;76:31;69:5;65:43;126:6;120:4;113:20;0:138;22579:38:2;;;;;;;;;22572:45;;22507:117;:::o;8304:891::-;8473:8;6292:18;6312:16;6332:26;6349:8;6332:16;:26::i;:::-;6291:67;;;;6454:1;6441:10;:14;6433:58;;;;;;;;;;;;;;;;;;;;;;;;6583:1;6570:10;:14;:35;;;;6601:4;6588:17;;:9;:7;:9::i;:::-;:17;;;6570:35;:63;;;;6621:12;:10;:12::i;:::-;6609:24;;:8;:24;;;6570:63;6562:122;;;;;;;;;;;;;;;;;;;;;;;;8493:18;8514:25;8523:5;8530:8;8514;:25::i;:::-;8493:46;;8549:23;8575:30;8584:8;8594:10;8575:8;:30::i;:::-;8549:56;;8665:5;8624:46;;:37;8645:15;8624:8;:20;;:37;;;;:::i;:::-;:46;;;8616:82;;;;;;;;;;;;;;;;;;;;;;;;8738:20;:18;:20::i;:::-;8834:36;8857:8;8867:2;8834:7;:22;;:36;;;;;:::i;:::-;;9032:5;8996:41;;:32;9017:10;8996:8;:20;;:32;;;;:::i;:::-;:41;;;8992:109;;;9052:38;9065:10;9077:2;9081:8;9052:12;:38::i;:::-;8992:109;9143:45;9167:15;9184:3;9143:8;:23;;:45;;;;;:::i;:::-;;6695:1;;8304:891;;;;;;;;:::o;2628:106::-;2668:66;2628:106;;;:::o;1549:45::-;;;;;;;;;;;;;;;;;:::o;17050:260::-;17119:7;17143:37;17164:15;17143:8;:20;;:37;;;;:::i;:::-;17139:165;;;17203:42;17229:15;17203:8;:25;;:42;;;;:::i;:::-;17196:49;;;;17139:165;17291:1;17283:10;;17276:17;;17050:260;;;;:::o;1724:137:17:-;1141:9;:7;:9::i;:::-;1133:54;;;;;;;;;;;;;;;;;;;;;;;;1822:1;1785:40;;1806:6;;;;;;;;;;;1785:40;;;;;;;;;;;;1852:1;1835:6;;:19;;;;;;;;;;;;;;;;;;1724:137::o;589:90:8:-;632:7;658:14;:12;:14::i;:::-;651:21;;589:90;:::o;11762:493:2:-;11923:18;11944:25;11953:5;11960:8;11944;:25::i;:::-;11923:46;;11979:23;12005:30;12014:8;12024:10;12005:8;:30::i;:::-;11979:56;;12046:44;12058:8;12068:5;12075:10;12087:2;12046:11;:44::i;:::-;12130:20;:18;:20::i;:::-;12193:54;12217:15;12242:3;12193:8;:23;;:54;;;;;:::i;:::-;;11762:493;;;;;;;:::o;945:210:11:-;1011:7;1052:12;:10;:12::i;:::-;1038:26;;:10;:26;;;1030:77;;;;;;;;;;;;;;;;;;;;;;;;1124:24;1140:7;;1124:24;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;30:3:-1;22:6;14;1:33;99:1;93:3;85:6;81:16;74:27;137:4;133:9;126:4;121:3;117:14;113:30;106:37;;169:3;161:6;157:16;147:26;;1124:24:11;;;;;;:15;:24::i;:::-;1117:31;;945:210;;;;:::o;3180:152:2:-;1055:12:16;;;;;;;;;;;:31;;;;1071:15;:13;:15::i;:::-;1055:31;:47;;;;1091:11;;;;;;;;;;;1090:12;1055:47;1047:106;;;;;;;;;;;;;;;;;;;;;;;;1164:19;1187:12;;;;;;;;;;;1186:13;1164:35;;1213:14;1209:96;;;1258:4;1243:12;;:19;;;;;;;;;;;;;;;;;;1290:4;1276:11;;:18;;;;;;;;;;;;;;;;;;1209:96;3231:33:2;3253:10;3231:21;:33::i;:::-;3274:28;:26;:28::i;:::-;3312:13;:11;:13::i;:::-;1331:14:16;1327:65;;;1376:5;1361:12;;:20;;;;;;;;;;;;;;;;;;1327:65;3180:152:2;:::o;15123:357::-;15237:18;15258:25;15267:5;15274:8;15258;:25::i;:::-;15237:46;;15294:44;15306:8;15316:10;15328:5;15335:2;15294:11;:44::i;:::-;15378:20;:18;:20::i;:::-;15434:39;15460:8;15470:2;15434:7;:25;;:39;;;;;:::i;:::-;;15123:357;;;;:::o;19772:655::-;20092:7;20101:12;20126:21;20150:15;:13;:15::i;:::-;20126:39;;20235:18;20256:10;:25;20267:13;20256:25;;;;;;;;;;;;20235:46;;20310:17;;;;;;;;;;;20296:31;;:10;:31;;20292:89;;;20349:21;20368:1;20349:18;:21::i;:::-;20342:28;;;;;;;;20292:89;20399:21;:19;:21::i;:::-;20392:28;;;;;;19772:655;;;;;;;;;;;;;;;:::o;13651:1193::-;13792:18;13813:25;13822:5;13829:8;13813;:25::i;:::-;13792:46;;13848:23;13874:30;13883:8;13893:10;13874:8;:30::i;:::-;13848:56;;13915:44;13927:8;13937:10;13949:5;13956:2;13915:11;:44::i;:::-;13999:20;:18;:20::i;:::-;14056:12;14071:35;14090:15;14071:8;:18;;:35;;;;:::i;:::-;14056:50;;14136:4;14125:15;;:7;:15;;;14117:46;;;;;;;;;;;;;;;;;;;;;;;;13651:1193;;;;;;;:::o;937:77:17:-;975:7;1001:6;;;;;;;;;;;994:13;;937:77;:::o;1288:92::-;1328:4;1367:6;;;;;;;;;;;1351:22;;:12;:10;:12::i;:::-;:22;;;1344:29;;1288:92;:::o;5892:186:2:-;5947:21;;:::i;:::-;5980:20;6003:30;6027:5;6003:8;:23;;:30;;;;:::i;:::-;5980:53;;6050:21;:7;:19;:21::i;:::-;6043:28;;;5892:186;;;:::o;793:227:8:-;841:13;999:14;;;;;;;;;;;;;;;;;;;;793:227;:::o;7162:1136:2:-;7324:8;6292:18;6312:16;6332:26;6349:8;6332:16;:26::i;:::-;6291:67;;;;6454:1;6441:10;:14;6433:58;;;;;;;;;;;;;;;;;;;;;;;;6583:1;6570:10;:14;:35;;;;6601:4;6588:17;;:9;:7;:9::i;:::-;:17;;;6570:35;:63;;;;6621:12;:10;:12::i;:::-;6609:24;;:8;:24;;;6570:63;6562:122;;;;;;;;;;;;;;;;;;;;;;;;7344:18;7365:25;7374:5;7381:8;7365;:25::i;:::-;7344:46;;7400:23;7426:30;7435:8;7445:10;7426:8;:30::i;:::-;7400:56;;7516:5;7475:46;;:37;7496:15;7475:8;:20;;:37;;;;:::i;:::-;:46;;;7467:82;;;;;;;;;;;;;;;;;;;;;;;;7589:20;:18;:20::i;:::-;7788:36;7811:8;7821:2;7788:7;:22;;:36;;;;;:::i;:::-;;7986:5;7950:41;;:32;7971:10;7950:8;:20;;:32;;;;:::i;:::-;:41;;;7946:109;;;8006:38;8019:10;8031:2;8035:8;8006:12;:38::i;:::-;7946:109;8172:54;8196:15;8221:3;8172:8;:23;;:54;;;;;:::i;:::-;;6695:1;;7162:1136;;;;;;;;:::o;20433:110::-;1141:9:17;:7;:9::i;:::-;1133:54;;;;;;;;;;;;;;;;;;;;;;;;20532:3:2;20505:17;;:31;;;;;;;;;;;;;;;;;;20433:110;:::o;17793:215::-;17855:16;17924:4;17891:37;;:29;17911:8;17891:7;:19;;:29;;;;:::i;:::-;:37;;;17883:67;;;;;;;;;;;;;;;;;;;;;;;;17968:33;17992:8;17968:7;:23;;:33;;;;:::i;:::-;17961:40;;17793:215;;;:::o;719:142:17:-;1055:12:16;;;;;;;;;;;:31;;;;1071:15;:13;:15::i;:::-;1055:31;:47;;;;1091:11;;;;;;;;;;;1090:12;1055:47;1047:106;;;;;;;;;;;;;;;;;;;;;;;;1164:19;1187:12;;;;;;;;;;;1186:13;1164:35;;1213:14;1209:96;;;1258:4;1243:12;;:19;;;;;;;;;;;;;;;;;;1290:4;1276:11;;:18;;;;;;;;;;;;;;;;;;1209:96;793:6:17;784;;:15;;;;;;;;;;;;;;;;;;847:6;;;;;;;;;;;814:40;;843:1;814:40;;;;;;;;;;;;1331:14:16;1327:65;;;1376:5;1361:12;;:20;;;;;;;;;;;;;;;;;;1327:65;719:142:17;;:::o;988:72:2:-;;;;;;;;;;;;;:::o;18797:363::-;18887:18;18907:16;18967:1;18947:21;;:6;:17;18954:9;18947:17;;;;;;;;;;;;:21;18939:54;;;;;;;;;;;;;;;;;;;;;;;;19004:21;19036:6;:17;19043:9;19036:17;;;;;;;;;;;;19028:26;;;19004:50;;19092:13;19078:29;;19065:42;;19151:1;19136:13;:16;52:12:-1;49:1;45:20;29:14;25:41;7:59;;19136:16:2;19117:36;;18797:363;;;;:::o;1412:276:11:-;1557:12;:10;:12::i;:::-;1543:26;;:10;:26;;;1535:77;;;;;;;;;;;;;;;;;;;;;;;;1622:59;1639:7;;1622:59;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;30:3:-1;22:6;14;1:33;99:1;93:3;85:6;81:16;74:27;137:4;133:9;126:4;121:3;117:14;113:30;106:37;;169:3;161:6;157:16;147:26;;1622:59:11;;;;;;1648:7;1657:12;1671:9;1622:16;:59::i;:::-;1412:276;;;;;:::o;17316:268:2:-;17388:12;17417:37;17438:15;17417:8;:20;;:37;;;;:::i;:::-;17413:165;;;17477:40;17501:15;17477:8;:23;;:40;;;;:::i;:::-;17470:47;;;;17413:165;17565:1;17555:12;;;;;;;;;;;;;;;;;;;;;;;;;29:1:-1;21:6;17:14;116:4;104:10;96:6;87:34;147:4;139:6;135:17;125:27;;0:156;17555:12:2;;;;17548:19;;17316:268;;;;:::o;5061:233::-;1141:9:17;:7;:9::i;:::-;1133:54;;;;;;;;;;;;;;;;;;;;;;;;5187:1:2;5168:20;;:6;:16;5175:8;5168:16;;;;;;;;;;;:20;;;;5198:52;2668:66;5225:13;;5240:9;5198:8;:26;;:52;;;;;:::i;:::-;;5260:27;5278:8;5260:7;:17;;:27;;;;:::i;:::-;;5061:233;;:::o;18014:145::-;18088:4;18111:41;18139:8;18149:2;18111:7;:27;;:41;;;;;:::i;:::-;18104:48;;18014:145;;;;:::o;2010:107:17:-;1141:9;:7;:9::i;:::-;1133:54;;;;;;;;;;;;;;;;;;;;;;;;2082:28;2101:8;2082:18;:28::i;:::-;2010:107;:::o;22237:264:2:-;22306:7;1141:9:17;:7;:9::i;:::-;1133:54;;;;;;;;;;;;;;;;;;;;;;;;22325:21:2;22349:13;:11;:13::i;:::-;22325:37;;22372:15;22390:13;:11;:13::i;:::-;:23;;;22422:4;22390:38;;;;;;;;;;;;;;;;;;;;;;;;;;;;8:9:-1;5:2;;;30:1;27;20:12;5:2;22390:38:2;;;;8:9:-1;5:2;;;45:16;42:1;39;24:38;77:16;74:1;67:27;5:2;22390:38:2;;;;;;;101:4:-1;97:9;90:4;84;80:15;76:31;69:5;65:43;126:6;120:4;113:20;0:138;22390:38:2;;;;;;;;;22372:56;;22438:8;:17;;;22456:7;22465:4;22438:32;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;8:9:-1;5:2;;;30:1;27;20:12;5:2;22438:32:2;;;;8:9:-1;5:2;;;45:16;42:1;39;24:38;77:16;74:1;67:27;5:2;22438:32:2;;;;22487:7;22480:14;;;;22237:264;;;:::o;22630:112::-;22676:12;22720:14;:12;:14::i;:::-;22700:35;;22630:112;:::o;5682:394:26:-;5806:4;5845:42;5882:4;5845:10;:24;;:36;;:42;;;;:::i;:::-;:103;;;;5903:45;5943:4;5903:10;:27;;:39;;:45;;;;:::i;:::-;5845:103;:162;;;;5964:43;6002:4;5964:10;:25;;:37;;:43;;;;:::i;:::-;5845:162;:224;;;;6023:46;6064:4;6023:10;:28;;:40;;:46;;;;:::i;:::-;5845:224;5826:243;;5682:394;;;;:::o;4706:229::-;4846:16;4881:47;4923:4;4881:10;:25;;:41;;:47;;;;:::i;:::-;4874:54;;4706:229;;;;:::o;9510:203::-;9636:7;9662:44;9702:3;9662:10;:24;;:39;;:44;;;;:::i;:::-;9655:51;;9510:203;;;;:::o;19166:275:2:-;1141:9:17;:7;:9::i;:::-;1133:54;;;;;;;;;;;;;;;;;;;;;;;;19275:21:2;19324:10;19307:27;;;;;;19380:1;19369:8;19361:20;;;;;;19344:37;;;;;;19420:13;19412:22;;19392:6;:17;19399:9;19392:17;;;;;;;;;;;:42;;;;1197:1:17;19166:275:2;;;:::o;20565:632:26:-;20709:4;20747:42;20784:4;20747:10;:24;;:36;;:42;;;;:::i;:::-;20746:43;20725:122;;;;;;;;;;;;;;;;;;;;;;;;20879:45;20919:4;20879:10;:27;;:39;;:45;;;;:::i;:::-;20878:46;20857:125;;;;;;;;;;;;;;;;;;;;;;;;21014:46;21055:4;21014:10;:28;;:40;;:46;;;;:::i;:::-;21013:47;20992:126;;;;;;;;;;;;;;;;;;;;;;;;21136:54;21177:4;21183:6;21136:10;:25;;:40;;:54;;;;;:::i;:::-;21129:61;;20565:632;;;;;:::o;818:168:21:-;925:4;952:27;975:3;952:13;:18;;:22;;:27;;;;:::i;:::-;945:34;;818:168;;;;:::o;1327:396:31:-;1472:12;;:::i;:::-;1526;:19;1504:11;:18;:41;1496:70;;;;;;;;;;;;;;;;;;;;;;;;1576:18;;:::i;:::-;1617:5;1604;:10;;:18;;;;;1648:46;1669:11;1681:12;1648:20;:46::i;:::-;1632:5;:13;;:62;;;;1711:5;1704:12;;;1327:396;;;;;:::o;5583:283:2:-;5674:4;5690:20;5713;:11;:18;:20::i;:::-;5690:43;;5817:42;5841:8;5851:7;5817:8;:23;;:42;;;;;:::i;:::-;5810:49;;;5583:283;;;;:::o;2181:207:7:-;2226:7;2263:14;:12;:14::i;:::-;2249:28;;:10;:28;;;;2245:137;;;2300:10;2293:17;;;;2245:137;2348:23;:21;:23::i;:::-;2341:30;;2181:207;;:::o;18374:317:2:-;18445:7;18464:19;18496:2;18486:13;;;;;;;;;;;;;;;;;;;;;;;;;29:1:-1;21:6;17:14;116:4;104:10;96:6;87:34;147:4;139:6;135:17;125:27;;0:156;18486:13:2;;;;18464:35;;18557:6;18552:2;18544:6;18540:15;18533:31;18601:4;18596:2;18588:6;18584:15;18577:29;18626:14;18653:6;18643:17;;;;;;18626:34;;18678:6;18671:13;;;;18374:317;;;;:::o;20722:282::-;20772:21;20796:15;:13;:15::i;:::-;20772:39;;20822:18;20843:10;:25;20854:13;20843:25;;;;;;;;;;;;20822:46;;20920:1;20907:10;:14;20879:10;:25;20890:13;20879:25;;;;;;;;;;;:42;;;;20722:282;;:::o;2339:312:21:-;2483:4;2503:31;2515:13;2530:3;2503:11;:31::i;:::-;2499:146;;;2557:34;2585:5;2557:13;:18;;:23;2576:3;2557:23;;;;;;;;;;;:27;;:34;;;;:::i;:::-;2550:41;;;;2499:146;2629:5;2622:12;;2339:312;;;;;;:::o;9326:683:2:-;9462:5;9426:41;;:32;9447:10;9426:8;:20;;:32;;;;:::i;:::-;:41;;;9418:75;;;;;;;;;;;;;;;;;;;;;;;;9504:19;9534:11;9548:8;;;;;;;;;;;:16;;;9565:3;9548:21;;;;;;;;;;;;;;;;;;;;;;;;;;;;8:9:-1;5:2;;;30:1;27;20:12;5:2;9548:21:2;;;;8:9:-1;5:2;;;45:16;42:1;39;24:38;77:16;74:1;67:27;5:2;9548:21:2;;;;;;;101:4:-1;97:9;90:4;84;80:15;76:31;69:5;65:43;126:6;120:4;113:20;0:138;9548:21:2;;;;;;;;;9534:35;;9579:11;9593:8;;;;;;;;;;;:17;;;9611:3;9593:22;;;;;;;;;;;;;;;;;;;;;;;;;;;;8:9:-1;5:2;;;30:1;27;20:12;5:2;9593:22:2;;;;8:9:-1;5:2;;;45:16;42:1;39;24:38;77:16;74:1;67:27;5:2;9593:22:2;;;;;;;101:4:-1;97:9;90:4;84;80:15;76:31;69:5;65:43;126:6;120:4;113:20;0:138;9593:22:2;;;;;;;;;9579:36;;9625:9;9637:8;;;;;;;;;;;:15;;;9653:3;9637:20;;;;;;;;;;;;;;;;;;;;;;;;;;;;8:9:-1;5:2;;;30:1;27;20:12;5:2;9637:20:2;;;;8:9:-1;5:2;;;45:16;42:1;39;24:38;77:16;74:1;67:27;5:2;9637:20:2;;;;;;;101:4:-1;97:9;90:4;84;80:15;76:31;69:5;65:43;126:6;120:4;113:20;0:138;9637:20:2;;;;;;;;;9625:32;;9683:4;9668:19;;;;;;9728:2;9720:5;9712:14;;:18;;;;9697:33;;;;9769:2;9763:3;9755:12;;:16;;;;9740:31;;;;9782:18;9817:11;9803:27;;9782:48;;9879:2;9864:12;:10;:12::i;:::-;9856:21;;:25;;;;9841:40;;;;9892:57;9916:10;9936:11;9928:20;;9892:8;:23;;:57;;;;;:::i;:::-;;9989:12;:10;:12::i;:::-;9965:37;;9979:8;9975:2;9965:37;;;;;;;;;;9326:683;;;;;;;;:::o;19584:637:26:-;19733:4;19771:42;19808:4;19771:10;:24;;:36;;:42;;;;:::i;:::-;19770:43;19749:122;;;;;;;;;;;;;;;;;;;;;;;;19903:43;19941:4;19903:10;:25;;:37;;:43;;;;:::i;:::-;19902:44;19881:123;;;;;;;;;;;;;;;;;;;;;;;;20036:46;20077:4;20036:10;:28;;:40;;:46;;;;:::i;:::-;20035:47;20014:126;;;;;;;;;;;;;;;;;;;;;;;;20158:56;20201:4;20207:6;20158:10;:27;;:42;;:56;;;;;:::i;:::-;20151:63;;19584:637;;;;;:::o;1110:248:7:-;1157:16;1185:12;754:66;1200:30;;1185:45;;1337:4;1331:11;1319:23;;1305:47;;:::o;10429:1327:2:-;10588:4;10543:49;;:41;10571:8;10581:2;10543:7;:27;;:41;;;;;:::i;:::-;:49;;;10535:90;;;;;;;;;;;;;;;;;;;;;;;;10637:18;10657:16;10677:26;10694:8;10677:16;:26::i;:::-;10636:67;;;;10799:1;10786:10;:14;10778:53;;;;;;;;;;;;;;;;;;;;;;;;10923:1;10910:10;:14;:35;;;;10941:4;10928:17;;:9;:7;:9::i;:::-;:17;;;10910:35;:63;;;;10961:12;:10;:12::i;:::-;10949:24;;:8;:24;;;10910:63;10902:122;;;;;;;;;;;;;;;;;;;;;;;;11212:1;11198:10;:15;;11194:556;;;11311:19;11333:37;11359:10;11333:8;:25;;:37;;;;:::i;:::-;11311:59;;11384:16;11433:2;11419:11;11411:20;;;:24;52:12:-1;49:1;45:20;29:14;25:41;7:59;;11411:24:2;11384:52;;11534:12;:10;:12::i;:::-;11522:24;;:8;:24;;;11518:222;;;;;;11631:4;11618:17;;:9;:7;:9::i;:::-;:17;;;:45;;;;11651:12;:10;:12::i;:::-;11639:24;;:8;:24;;;11618:45;11610:115;;;;;;;;;;;;;;;;;;;;;;;;11518:222;11194:556;;;10429:1327;;;;;;:::o;16647:632:26:-;16791:4;16829:45;16869:4;16829:10;:27;;:39;;:45;;;;:::i;:::-;16828:46;16807:125;;;;;;;;;;;;;;;;;;;;;;;;16964:43;17002:4;16964:10;:25;;:37;;:43;;;;:::i;:::-;16963:44;16942:123;;;;;;;;;;;;;;;;;;;;;;;;17097:46;17138:4;17097:10;:28;;:40;;:46;;;;:::i;:::-;17096:47;17075:126;;;;;;;;;;;;;;;;;;;;;;;;17219:53;17259:4;17265:6;17219:10;:24;;:39;;:53;;;;;:::i;:::-;17212:60;;16647:632;;;;;:::o;21540:81:2:-;21605:7;21540:81;;;:::o;1488:536:16:-;1535:4;1900:12;1923:4;1900:28;;1938:10;1987:4;1975:17;1969:23;;2016:1;2010:2;:7;2003:14;;;;1488:536;:::o;499:84:8:-;1055:12:16;;;;;;;;;;;:31;;;;1071:15;:13;:15::i;:::-;1055:31;:47;;;;1091:11;;;;;;;;;;;1090:12;1055:47;1047:106;;;;;;;;;;;;;;;;;;;;;;;;1164:19;1187:12;;;;;;;;;;;1186:13;1164:35;;1213:14;1209:96;;;1258:4;1243:12;;:19;;;;;;;;;;;;;;;;;;1290:4;1276:11;;:18;;;;;;;;;;;;;;;;;;1209:96;550:26:8;:24;:26::i;:::-;1331:14:16;1327:65;;;1376:5;1361:12;;:20;;;;;;;;;;;;;;;;;;1327:65;499:84:8;:::o;3338:279:2:-;3400:4;3380:17;;:24;;;;;;;;;;;;;;;;;;3524:86;2668:66;3540:13;;3555:54;3524:8;:15;;:86;;;;;:::i;:::-;;3338:279::o;12261:1221::-;12420:4;12375:49;;:41;12403:8;12413:2;12375:7;:27;;:41;;;;;:::i;:::-;:49;;;12367:78;;;;;;;;;;;;;;;;;;;;;;;;12457:18;12477:16;12497:26;12514:8;12497:16;:26::i;:::-;12456:67;;;;12619:1;12606:10;:14;12598:58;;;;;;;;;;;;;;;;;;;;;;;;12748:1;12735:10;:14;:35;;;;12766:4;12753:17;;:9;:7;:9::i;:::-;:17;;;12735:35;:63;;;;12786:12;:10;:12::i;:::-;12774:24;;:8;:24;;;12735:63;12727:122;;;;;;;;;;;;;;;;;;;;;;;;13037:1;13023:10;:15;;13019:457;;;13058:9;:7;:9::i;:::-;:37;;;;13083:12;:10;:12::i;:::-;13071:24;;:8;:24;;;13058:37;13054:412;;;;;;13244:19;13266:37;13292:10;13266:8;:25;;:37;;;;:::i;:::-;13244:59;;13321:16;13370:2;13356:11;13348:20;;;:24;52:12:-1;49:1;45:20;29:14;25:41;7:59;;13348:24:2;13321:52;;13411:12;:10;:12::i;:::-;13399:24;;:8;:24;;;13391:60;;;;;;;;;;;;;;;;;;;;;;;;13054:412;;;13019:457;12261:1221;;;;;;:::o;3131:318:21:-;3278:4;3298:31;3310:13;3325:3;3298:11;:31::i;:::-;3294:149;;;3352:37;3383:5;3352:13;:18;;:23;3371:3;3352:23;;;;;;;;;;;:30;;:37;;;;:::i;:::-;3345:44;;;;3294:149;3427:5;3420:12;;3131:318;;;;;;:::o;21032:403:2:-;21080:21;21114:15;21140:11;21154:8;;;;;;;;;;;:16;;;21171:3;21154:21;;;;;;;;;;;;;;;;;;;;;;;;;;;;8:9:-1;5:2;;;30:1;27;20:12;5:2;21154:21:2;;;;8:9:-1;5:2;;;45:16;42:1;39;24:38;77:16;74:1;67:27;5:2;21154:21:2;;;;;;;101:4:-1;97:9;90:4;84;80:15;76:31;69:5;65:43;126:6;120:4;113:20;0:138;21154:21:2;;;;;;;;;21140:35;;21185:11;21199:8;;;;;;;;;;;:17;;;21217:3;21199:22;;;;;;;;;;;;;;;;;;;;;;;;;;;;8:9:-1;5:2;;;30:1;27;20:12;5:2;21199:22:2;;;;8:9:-1;5:2;;;45:16;42:1;39;24:38;77:16;74:1;67:27;5:2;21199:22:2;;;;;;;101:4:-1;97:9;90:4;84;80:15;76:31;69:5;65:43;126:6;120:4;113:20;0:138;21199:22:2;;;;;;;;;21185:36;;21231:9;21243:8;;;;;;;;;;;:15;;;21259:3;21243:20;;;;;;;;;;;;;;;;;;;;;;;;;;;;8:9:-1;5:2;;;30:1;27;20:12;5:2;21243:20:2;;;;8:9:-1;5:2;;;45:16;42:1;39;24:38;77:16;74:1;67:27;5:2;21243:20:2;;;;;;;101:4:-1;97:9;90:4;84;80:15;76:31;69:5;65:43;126:6;120:4;113:20;0:138;21243:20:2;;;;;;;;;21231:32;;21285:4;21274:15;;;;;;21326:2;21318:5;21310:14;;:18;;;;21299:29;;;;21363:2;21357:3;21349:12;;:16;;;;21338:27;;;;21419:7;21402:25;;;;;;;;;;;;;;;49:4:-1;39:7;30;26:21;22:32;13:7;6:49;21402:25:2;;;21392:36;;;;;;21376:52;;21032:403;;;;;:::o;2441:156:11:-;2511:7;2520:12;2576:9;427:2;2552:33;2544:46;;;;;;;;;;;;;;;;;2441:156;;;:::o;1869:124::-;1923:7;1932:12;1963:23;;;;;;;;;;;;;;:19;:23::i;:::-;1956:30;;;;1869:124;;:::o;26241:371:26:-;26350:4;26389:40;26424:4;26389:10;:24;;:34;;:40;;;;:::i;:::-;:99;;;;26445:43;26483:4;26445:10;:27;;:37;;:43;;;;:::i;:::-;26389:99;:156;;;;26504:41;26540:4;26504:10;:25;;:35;;:41;;;;:::i;:::-;26389:156;:216;;;;26561:44;26600:4;26561:10;:28;;:38;;:44;;;;:::i;:::-;26389:216;26370:235;;26241:371;;;;:::o;11579:209::-;11703:12;11734:47;11777:3;11734:10;:27;;:42;;:47;;;;:::i;:::-;11727:54;;11579:209;;;;:::o;2286:403:31:-;2375:12;;:::i;:::-;2403:14;2420:6;:13;2403:30;;2443:18;;:::i;:::-;2484:24;2501:6;2484;:16;;:24;;;;:::i;:::-;2471:5;:10;;:37;;;;;2528:2;2518:12;;;;2566:31;2590:6;2566;:23;;:31;;;;:::i;:::-;2540:57;;;2541:5;:13;;2540:57;;;;;;;;2626:1;2616:6;:11;2608:52;;;;;;;;;;;;;;;;;;;;;;;;2677:5;2670:12;;;;2286:403;;;:::o;992:185:21:-;1115:4;1138:32;1166:3;1138:13;:18;;:27;;:32;;;;:::i;:::-;1131:39;;992:185;;;;:::o;4160:319::-;4287:16;4319:31;4331:13;4346:3;4319:11;:31::i;:::-;4315:158;;;4373:35;:13;:18;;:23;4392:3;4373:23;;;;;;;;;;;:33;:35::i;:::-;4366:42;;;;4315:158;4460:1;4446:16;;;;;;;;;;;;;;;;;;;;;;29:2:-1;21:6;17:15;117:4;105:10;97:6;88:34;148:4;140:6;136:17;126:27;;0:157;4446:16:21;;;;4439:23;;4160:319;;;;;:::o;21627:101:2:-;;;;;:::o;26876:234:26:-;27023:4;27046:57;27090:4;27096:6;27046:10;:25;;:43;;:57;;;;;:::i;:::-;27039:64;;26876:234;;;;;:::o;2657:324:21:-;2767:4;2791:31;2803:13;2818:3;2791:11;:31::i;:::-;2787:188;;;2891:30;2917:3;2891:13;:18;;:25;;:30;;;;:::i;:::-;2884:37;;;;2787:188;2959:5;2952:12;;2657:324;;;;;:::o;3540:327::-;3694:4;3714:31;3726:13;3741:3;3714:11;:31::i;:::-;3710:151;;;3768:39;3801:5;3768:13;:18;;:23;3787:3;3768:23;;;;;;;;;;;:32;;:39;;;;:::i;:::-;3761:46;;;;3710:151;3845:5;3838:12;;3540:327;;;;;;:::o;2218:225:17:-;2311:1;2291:22;;:8;:22;;;;2283:73;;;;;;;;;;;;;;;;;;;;;;;;2400:8;2371:38;;2392:6;;;;;;;;;;;2371:38;;;;;;;;;;;;2428:8;2419:6;;:17;;;;;;;;;;;;;;;;;;2218:225;:::o;897:190:20:-;1021:4;1044:36;1076:3;1044:17;:22;;:31;;:36;;;;:::i;:::-;1037:43;;897:190;;;;:::o;803::23:-;925:4;952:34;982:3;952:15;:20;;:29;;:34;;;;:::i;:::-;945:41;;803:190;;;;:::o;1212:189:24:-;1335:4;1362:32;1390:3;1362:13;:18;;:27;;:32;;;;:::i;:::-;1355:39;;1212:189;;;;:::o;3034:265:20:-;3161:7;3188:35;3200:17;3219:3;3188:11;:35::i;:::-;3180:67;;;;;;;;;;;;;;;;;;;;;;;;3265:17;:22;;:27;3288:3;3265:27;;;;;;;;;;;;3258:34;;3034:265;;;;:::o;1036:273:22:-;1122:4;1147:20;1156:3;1161:5;1147:8;:20::i;:::-;1146:21;1142:161;;;1202:3;:10;;1218:5;1202:22;;39:1:-1;33:3;27:10;23:18;57:10;52:3;45:23;79:10;72:17;;0:93;1202:22:22;;;;;;;;;;;;;;;;;;;;;1183:3;:9;;:16;1193:5;1183:16;;;;;;;;;;;:41;;;;1245:4;1238:11;;;;1142:161;1287:5;1280:12;;1036:273;;;;;:::o;1083:535:30:-;1209:15;1266:12;:19;1244:11;:18;:41;1236:70;;;;;;;;;;;;;;;;;;;;;;;;1317:23;1356:11;:18;1343:32;;;;;;;;;;;;;;;;;;;;;;;;;:::i;:::-;;;;;;;;;;;;;;;;;1317:58;;1390:9;1402:1;1390:13;;1385:202;1409:11;:18;1405:1;:22;1385:202;;;1448:17;;:::i;:::-;1490:11;1502:1;1490:14;;;;;;;;;;;;;;;;;;1479:3;:8;;:25;;;;;1531:12;1544:1;1531:15;;;;;;;;;;;;;;;;;;1518:3;:10;;:28;;;;;1573:3;1560:7;1568:1;1560:10;;;;;;;;;;;;;;;;;:16;;;;1385:202;1429:3;;;;;;;1385:202;;;;1604:7;1597:14;;;1083:535;;;;:::o;1780:424:31:-;1839:12;1863:14;1880:11;1885:5;1880:4;:11::i;:::-;1863:28;;1901:17;1931:6;1921:17;;;;;;;;;;;;;;;;;;;;;;;;;29:1:-1;21:6;17:14;116:4;104:10;96:6;87:34;147:4;139:6;135:17;125:27;;0:156;1921:17:31;;;;1901:37;;1963:38;1988:6;1996:4;1963:5;:10;;;:24;;:38;;;;;:::i;:::-;2054:2;2044:12;;;;2075:38;2100:6;2108:4;2075:5;:13;;;:24;;:38;;;;;:::i;:::-;2066:47;;2142:1;2132:6;:11;2124:52;;;;;;;;;;;;;;;;;;;;;;;;2193:4;2186:11;;;;1780:424;;;:::o;2606:1238:7:-;2661:14;3460:18;3481:8;;3460:29;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;30:3:-1;22:6;14;1:33;99:1;93:3;85:6;81:16;74:27;137:4;133:9;126:4;121:3;117:14;113:30;106:37;;169:3;161:6;157:16;147:26;;3460:29:7;;;;;;;;3499:13;3515:8;;:15;;3499:31;;3762:42;3753:5;3746;3742:17;3736:24;3732:73;3722:83;;3831:6;3824:13;;;;2606:1238;:::o;2162:248:23:-;2308:4;2352:5;2324:15;:20;;:25;2345:3;2324:25;;;;;;;;;;;:33;;;;;;;;;;;;:::i;:::-;;2374:29;2399:3;2374:15;:20;;:24;;:29;;;;:::i;:::-;2367:36;;2162:248;;;;;:::o;2284:251:20:-;2429:4;2475:5;2445:17;:22;;:27;2468:3;2445:27;;;;;;;;;;;:35;;;;2497:31;2524:3;2497:17;:22;;:26;;:31;;;;:::i;:::-;2490:38;;2284:251;;;;;:::o;913:191:7:-;1055:12:16;;;;;;;;;;;:31;;;;1071:15;:13;:15::i;:::-;1055:31;:47;;;;1091:11;;;;;;;;;;;1090:12;1055:47;1047:106;;;;;;;;;;;;;;;;;;;;;;;;1164:19;1187:12;;;;;;;;;;;1186:13;1164:35;;1213:14;1209:96;;;1258:4;1243:12;;:19;;;;;;;;;;;;;;;;;;1290:4;1276:11;;:18;;;;;;;;;;;;;;;;;;1209:96;1037:60:7;1054:42;1037:16;:60::i;:::-;1331:14:16;1327:65;;;1376:5;1361:12;;:20;;;;;;;;;;;;;;;;;;1327:65;913:191:7;:::o;24588:1438:26:-;24730:4;24769:1;24760:5;24754:12;;;;;;;;:16;;;24746:48;;;;;;;;;;;;;;;;;;;;;;;;24826:42;24863:4;24826:10;:24;;:36;;:42;;;;:::i;:::-;24825:43;24804:122;;;;;;;;;;;;;;;;;;;;;;;;24958:45;24998:4;24958:10;:27;;:39;;:45;;;;:::i;:::-;24957:46;24936:125;;;;;;;;;;;;;;;;;;;;;;;;25093:43;25131:4;25093:10;:25;;:37;;:43;;;;:::i;:::-;25092:44;25071:123;;;;;;;;;;;;;;;;;;;;;;;;25226:46;25267:4;25226:10;:28;;:40;;:46;;;;:::i;:::-;25225:47;25204:126;;;;;;;;;;;;;;;;;;;;;;;;25378:5;25345:38;;;;;;;;:29;:38;;;;;;;;;25341:114;;;25406:38;25439:4;25406:10;:25;;:32;;:38;;;;:::i;:::-;25399:45;;;;25341:114;25504:5;25468:41;;;;;;;;:32;:41;;;;;;;;;25464:120;;;25532:41;25568:4;25532:10;:28;;:35;;:41;;;;:::i;:::-;25525:48;;;;25464:120;25629:5;25597:37;;;;;;;;:28;:37;;;;;;;;;25593:262;;;25673:171;25734:4;25760:66;25673:171;;:10;:24;;:39;;:171;;;;;:::i;:::-;25650:194;;;;25593:262;25903:5;25868:40;;;;;;;;:31;:40;;;;;;;;;25864:156;;;25947:62;25990:4;26006:1;25996:12;;;;;;;;;;;;;;;;;;;;;;;;;29:1:-1;21:6;17:14;116:4;104:10;96:6;87:34;147:4;139:6;135:17;125:27;;0:156;25996:12:26;;;;25947:10;:27;;:42;;:62;;;;;:::i;:::-;25924:85;;;;25864:156;24588:1438;;;;;;:::o;1439:1020:22:-;1528:4;1552:20;1561:3;1566:5;1552:8;:20::i;:::-;1548:905;;;1588:21;1631:1;1612:3;:9;;:16;1622:5;1612:16;;;;;;;;;;;;:20;1588:44;;1646:17;1686:1;1666:3;:10;;:17;;;;:21;1646:41;;1824:13;1811:9;:26;;1807:382;;;1857:17;1877:3;:10;;1888:9;1877:21;;;;;;;;;;;;;;;;;;1857:41;;2024:9;1996:3;:10;;2007:13;1996:25;;;;;;;;;;;;;;;;;:37;;;;2146:1;2130:13;:17;2107:3;:9;;:20;2117:9;2107:20;;;;;;;;;;;:40;;;;1807:382;;2270:3;:9;;:16;2280:5;2270:16;;;;;;;;;;;2263:23;;;2357:3;:10;;:16;;;;;;;;;;;;;;;;;;;;;;;;;;2395:4;2388:11;;;;;;1548:905;2437:5;2430:12;;1439:1020;;;;;:::o;2157:153:11:-;2231:7;2240:12;371:1;2295:7;2264:39;;;;2157:153;;;:::o;2693:335:20:-;2804:4;2828:35;2840:17;2859:3;2828:11;:35::i;:::-;2824:198;;;2886:17;:22;;:27;2909:3;2886:27;;;;;;;;;;;2879:34;;;2934;2964:3;2934:17;:22;;:29;;:34;;;;:::i;:::-;2927:41;;;;2824:198;3006:5;2999:12;;2693:335;;;;;:::o;2564:325:23:-;2671:4;2695:33;2707:15;2724:3;2695:11;:33::i;:::-;2691:192;;;2751:15;:20;;:25;2772:3;2751:25;;;;;;;;;;;;2744:32;;;;:::i;:::-;2797;2825:3;2797:15;:20;;:27;;:32;;;;:::i;:::-;2790:39;;;;2691:192;2867:5;2860:12;;2564:325;;;;;:::o;2878:322:24:-;2986:4;3010:31;3022:13;3037:3;3010:11;:31::i;:::-;3006:188;;;3110:30;3136:3;3110:13;:18;;:25;;:30;;;;:::i;:::-;3103:37;;;;3006:188;3178:5;3171:12;;2878:322;;;;;:::o;2895:262:23:-;3018:12;3050:33;3062:15;3079:3;3050:11;:33::i;:::-;3042:65;;;;;;;;;;;;;;;;;;;;;;;;3125:15;:20;;:25;3146:3;3125:25;;;;;;;;;;;3118:32;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;2895:262;;;;:::o;4371:349:27:-;4474:15;4557:6;4549;4545:19;4539:26;4528:37;;4514:200;;;;:::o;5339:641:30:-;5430:15;5447:7;5466:14;5483:11;5466:28;;5504:16;5523:24;5540:6;5523;:16;;:24;;;;:::i;:::-;5504:43;;5567:2;5557:12;;;;5580:11;377:2;5594:8;:15;;;;;;;;5580:29;;5619:22;5657:3;5644:17;;;;;;;;;;;;;;;;;;;;;;;;;:::i;:::-;;;;;;;;;;;;;;;;;5619:42;;5676:9;5688:1;5676:13;;5671:269;5695:3;5691:1;:7;5671:269;;;5719:20;;:::i;:::-;5767:24;5784:6;5767;:16;;:24;;;;:::i;:::-;5753:6;:11;;:38;;;;;5815:2;5805:12;;;;5847:24;5864:6;5847;:16;;:24;;;;:::i;:::-;5831:6;:13;;:40;;;;;5895:2;5885:12;;;;5923:6;5911;5918:1;5911:9;;;;;;;;;;;;;;;;;:18;;;;5671:269;5700:3;;;;;;;5671:269;;;;5958:6;5966;5950:23;;;;;;;;5339:641;;;;;:::o;2540:159:22:-;2644:4;2691:1;2671:3;:9;;:16;2681:5;2671:16;;;;;;;;;;;;:21;;2664:28;;2540:159;;;;:::o;3052:313::-;3142:16;3174:23;3214:3;:10;;:17;;;;3200:32;;;;;;;;;;;;;;;;;;;;;;29:2:-1;21:6;17:15;117:4;105:10;97:6;88:34;148:4;140:6;136:17;126:27;;0:157;3200:32:22;;;;3174:58;;3247:9;3242:94;3262:3;:10;;:17;;;;3258:1;:21;3242:94;;;3312:3;:10;;3323:1;3312:13;;;;;;;;;;;;;;;;;;3300:6;3307:1;3300:9;;;;;;;;;;;;;;;;;:25;;;;;3281:3;;;;;;;3242:94;;;;3352:6;3345:13;;;3052:313;;;:::o;666:166:31:-;738:7;776:21;:6;:14;;;:19;:21::i;:::-;771:2;532;764:9;:33;757:40;;666:166;;;:::o;686:174:29:-;837:6;828;819:7;815:20;808:36;794:60;;;:::o;3133:509:30:-;3241:7;3260:14;3277:11;3260:28;;3321:35;3343:6;3351:4;3321:13;3326:7;3321:4;:13::i;:::-;:21;;:35;;;;;:::i;:::-;3376:2;3366:12;;;;3393:9;3405:1;3393:13;;3388:224;3412:7;:14;3408:1;:18;3388:224;;;3447:43;3477:6;3485:4;3447:7;3455:1;3447:10;;;;;;;;;;;;;;;;;;:15;;;:29;;:43;;;;;:::i;:::-;3514:2;3504:12;;;;3530:45;3562:6;3570:4;3530:7;3538:1;3530:10;;;;;;;;;;;;;;;;;;:17;;;:31;;:45;;;;;:::i;:::-;3599:2;3589:12;;;;3428:3;;;;;;;3388:224;;;;3629:6;3622:13;;;3133:509;;;;;:::o;1364:541:7:-;1430:23;1456:14;:12;:14::i;:::-;1430:40;;1511:1;1488:25;;:11;:25;;;;1480:82;;;;;;;;;;;;;;;;;;;;;;;;1595:15;1580:30;;:11;:30;;;;1572:86;;;;;;;;;;;;;;;;;;;;;;;;1707:11;1674:45;;1690:15;1674:45;;;;;;;;;;;;1730:12;754:66;1745:30;;1730:45;;1877:11;1871:4;1864:25;1850:49;;;:::o;1040:166:24:-;1145:4;1172:27;1195:3;1172:13;:18;;:22;;:27;;;;:::i;:::-;1165:34;;1040:166;;;;:::o;18218:210:27:-;18321:15;18404:6;18396;18392:19;18386:26;18375:37;;18361:61;;;;:::o;511:130:30:-;587:7;377:2;613:7;:14;:21;606:28;;511:130;;;:::o;2013:165:29:-;2155:6;2146;2137:7;2133:20;2126:36;2112:60;;;:::o;782:21962:2:-;;;;;;;;;;;;;;;;;;;;;;;:::o;:::-;;;;;;;;;;;;;;;;;;;;;;;;;;:::o;:::-;;;;;;;;;;;;;;;;;;;;;;;;;;:::o;:::-;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;:::i;:::-;;;:::o;:::-;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;:::i;:::-;;;:::o;:::-;;;;;;;;;;;;;;;;;;;;;;;;;;;:::o;5:118:-1:-;;72:46;110:6;97:20;72:46;;;63:55;;57:66;;;;;130:134;;205:54;251:6;238:20;205:54;;;196:63;;190:74;;;;;289:707;;406:3;399:4;391:6;387:17;383:27;376:35;373:2;;;424:1;421;414:12;373:2;461:6;448:20;483:80;498:64;555:6;498:64;;;483:80;;;474:89;;580:5;605:6;598:5;591:21;635:4;627:6;623:17;613:27;;657:4;652:3;648:14;641:21;;710:6;757:3;749:4;741:6;737:17;732:3;728:27;725:36;722:2;;;774:1;771;764:12;722:2;799:1;784:206;809:6;806:1;803:13;784:206;;;867:3;889:37;922:3;910:10;889:37;;;884:3;877:50;950:4;945:3;941:14;934:21;;978:4;973:3;969:14;962:21;;841:149;831:1;828;824:9;819:14;;784:206;;;788:14;366:630;;;;;;;;1004:112;;1068:43;1103:6;1090:20;1068:43;;;1059:52;;1053:63;;;;;1123:118;;1190:46;1228:6;1215:20;1190:46;;;1181:55;;1175:66;;;;;1262:335;;;1376:3;1369:4;1361:6;1357:17;1353:27;1346:35;1343:2;;;1394:1;1391;1384:12;1343:2;1427:6;1414:20;1404:30;;1454:18;1446:6;1443:30;1440:2;;;1486:1;1483;1476:12;1440:2;1520:4;1512:6;1508:17;1496:29;;1570:3;1563;1555:6;1551:16;1541:8;1537:31;1534:40;1531:2;;;1587:1;1584;1577:12;1531:2;1336:261;;;;;;1606:440;;1707:3;1700:4;1692:6;1688:17;1684:27;1677:35;1674:2;;;1725:1;1722;1715:12;1674:2;1762:6;1749:20;1784:64;1799:48;1840:6;1799:48;;;1784:64;;;1775:73;;1868:6;1861:5;1854:21;1904:4;1896:6;1892:17;1937:4;1930:5;1926:16;1972:3;1963:6;1958:3;1954:16;1951:25;1948:2;;;1989:1;1986;1979:12;1948:2;1999:41;2033:6;2028:3;2023;1999:41;;;1667:379;;;;;;;;2054:120;;2131:38;2161:6;2155:13;2131:38;;;2122:47;;2116:58;;;;;2181:118;;2248:46;2286:6;2273:20;2248:46;;;2239:55;;2233:66;;;;;2306:122;;2384:39;2415:6;2409:13;2384:39;;;2375:48;;2369:59;;;;;2435:114;;2500:44;2536:6;2523:20;2500:44;;;2491:53;;2485:64;;;;;2556:118;;2632:37;2661:6;2655:13;2632:37;;;2623:46;;2617:57;;;;;2681:241;;2785:2;2773:9;2764:7;2760:23;2756:32;2753:2;;;2801:1;2798;2791:12;2753:2;2836:1;2853:53;2898:7;2889:6;2878:9;2874:22;2853:53;;;2843:63;;2815:97;2747:175;;;;;2929:257;;3041:2;3029:9;3020:7;3016:23;3012:32;3009:2;;;3057:1;3054;3047:12;3009:2;3092:1;3109:61;3162:7;3153:6;3142:9;3138:22;3109:61;;;3099:71;;3071:105;3003:183;;;;;3193:1497;;;;;;;;;;;;3472:3;3460:9;3451:7;3447:23;3443:33;3440:2;;;3489:1;3486;3479:12;3440:2;3524:1;3541:53;3586:7;3577:6;3566:9;3562:22;3541:53;;;3531:63;;3503:97;3631:2;3649:53;3694:7;3685:6;3674:9;3670:22;3649:53;;;3639:63;;3610:98;3767:2;3756:9;3752:18;3739:32;3791:18;3783:6;3780:30;3777:2;;;3823:1;3820;3813:12;3777:2;3851:64;3907:7;3898:6;3887:9;3883:22;3851:64;;;3833:82;;;;3718:203;3952:2;3970:53;4015:7;4006:6;3995:9;3991:22;3970:53;;;3960:63;;3931:98;4060:3;4079:53;4124:7;4115:6;4104:9;4100:22;4079:53;;;4069:63;;4039:99;4169:3;4188:53;4233:7;4224:6;4213:9;4209:22;4188:53;;;4178:63;;4148:99;4278:3;4297:53;4342:7;4333:6;4322:9;4318:22;4297:53;;;4287:63;;4257:99;4415:3;4404:9;4400:19;4387:33;4440:18;4432:6;4429:30;4426:2;;;4472:1;4469;4462:12;4426:2;4500:64;4556:7;4547:6;4536:9;4532:22;4500:64;;;4482:82;;;;4366:204;4601:3;4621:53;4666:7;4657:6;4646:9;4642:22;4621:53;;;4610:64;;4580:100;3434:1256;;;;;;;;;;;;;;;4697:241;;4801:2;4789:9;4780:7;4776:23;4772:32;4769:2;;;4817:1;4814;4807:12;4769:2;4852:1;4869:53;4914:7;4905:6;4894:9;4890:22;4869:53;;;4859:63;;4831:97;4763:175;;;;;4945:366;;;5066:2;5054:9;5045:7;5041:23;5037:32;5034:2;;;5082:1;5079;5072:12;5034:2;5117:1;5134:53;5179:7;5170:6;5159:9;5155:22;5134:53;;;5124:63;;5096:97;5224:2;5242:53;5287:7;5278:6;5267:9;5263:22;5242:53;;;5232:63;;5203:98;5028:283;;;;;;5318:491;;;;5456:2;5444:9;5435:7;5431:23;5427:32;5424:2;;;5472:1;5469;5462:12;5424:2;5507:1;5524:53;5569:7;5560:6;5549:9;5545:22;5524:53;;;5514:63;;5486:97;5614:2;5632:53;5677:7;5668:6;5657:9;5653:22;5632:53;;;5622:63;;5593:98;5722:2;5740:53;5785:7;5776:6;5765:9;5761:22;5740:53;;;5730:63;;5701:98;5418:391;;;;;;5816:617;;;;;5971:3;5959:9;5950:7;5946:23;5942:33;5939:2;;;5988:1;5985;5978:12;5939:2;6023:1;6040:53;6085:7;6076:6;6065:9;6061:22;6040:53;;;6030:63;;6002:97;6130:2;6148:53;6193:7;6184:6;6173:9;6169:22;6148:53;;;6138:63;;6109:98;6238:2;6256:53;6301:7;6292:6;6281:9;6277:22;6256:53;;;6246:63;;6217:98;6346:2;6364:53;6409:7;6400:6;6389:9;6385:22;6364:53;;;6354:63;;6325:98;5933:500;;;;;;;;6440:743;;;;;;6612:3;6600:9;6591:7;6587:23;6583:33;6580:2;;;6629:1;6626;6619:12;6580:2;6664:1;6681:53;6726:7;6717:6;6706:9;6702:22;6681:53;;;6671:63;;6643:97;6771:2;6789:53;6834:7;6825:6;6814:9;6810:22;6789:53;;;6779:63;;6750:98;6879:2;6897:53;6942:7;6933:6;6922:9;6918:22;6897:53;;;6887:63;;6858:98;6987:2;7005:53;7050:7;7041:6;7030:9;7026:22;7005:53;;;6995:63;;6966:98;7095:3;7114:53;7159:7;7150:6;7139:9;7135:22;7114:53;;;7104:63;;7074:99;6574:609;;;;;;;;;7190:847;;;;;;7371:3;7359:9;7350:7;7346:23;7342:33;7339:2;;;7388:1;7385;7378:12;7339:2;7423:1;7440:53;7485:7;7476:6;7465:9;7461:22;7440:53;;;7430:63;;7402:97;7530:2;7548:53;7593:7;7584:6;7573:9;7569:22;7548:53;;;7538:63;;7509:98;7638:2;7656:53;7701:7;7692:6;7681:9;7677:22;7656:53;;;7646:63;;7617:98;7746:2;7764:53;7809:7;7800:6;7789:9;7785:22;7764:53;;;7754:63;;7725:98;7882:3;7871:9;7867:19;7854:33;7907:18;7899:6;7896:30;7893:2;;;7939:1;7936;7929:12;7893:2;7959:62;8013:7;8004:6;7993:9;7989:22;7959:62;;;7949:72;;7833:194;7333:704;;;;;;;;;8044:1011;;;;;;8264:3;8252:9;8243:7;8239:23;8235:33;8232:2;;;8281:1;8278;8271:12;8232:2;8316:1;8333:53;8378:7;8369:6;8358:9;8354:22;8333:53;;;8323:63;;8295:97;8423:2;8441:53;8486:7;8477:6;8466:9;8462:22;8441:53;;;8431:63;;8402:98;8531:2;8549:51;8592:7;8583:6;8572:9;8568:22;8549:51;;;8539:61;;8510:96;8665:2;8654:9;8650:18;8637:32;8689:18;8681:6;8678:30;8675:2;;;8721:1;8718;8711:12;8675:2;8741:78;8811:7;8802:6;8791:9;8787:22;8741:78;;;8731:88;;8616:209;8884:3;8873:9;8869:19;8856:33;8909:18;8901:6;8898:30;8895:2;;;8941:1;8938;8931:12;8895:2;8961:78;9031:7;9022:6;9011:9;9007:22;8961:78;;;8951:88;;8835:210;8226:829;;;;;;;;;9062:365;;;9185:2;9173:9;9164:7;9160:23;9156:32;9153:2;;;9201:1;9198;9191:12;9153:2;9264:1;9253:9;9249:17;9236:31;9287:18;9279:6;9276:30;9273:2;;;9319:1;9316;9309:12;9273:2;9347:64;9403:7;9394:6;9383:9;9379:22;9347:64;;;9329:82;;;;9215:202;9147:280;;;;;;9434:735;;;;;;9605:3;9593:9;9584:7;9580:23;9576:33;9573:2;;;9622:1;9619;9612:12;9573:2;9685:1;9674:9;9670:17;9657:31;9708:18;9700:6;9697:30;9694:2;;;9740:1;9737;9730:12;9694:2;9768:64;9824:7;9815:6;9804:9;9800:22;9768:64;;;9750:82;;;;9636:202;9869:2;9887:50;9929:7;9920:6;9909:9;9905:22;9887:50;;;9877:60;;9848:95;9974:2;9992:53;10037:7;10028:6;10017:9;10013:22;9992:53;;;9982:63;;9953:98;10082:2;10100:53;10145:7;10136:6;10125:9;10121:22;10100:53;;;10090:63;;10061:98;9567:602;;;;;;;;;10176:261;;10290:2;10278:9;10269:7;10265:23;10261:32;10258:2;;;10306:1;10303;10296:12;10258:2;10341:1;10358:63;10413:7;10404:6;10393:9;10389:22;10358:63;;;10348:73;;10320:107;10252:185;;;;;10444:241;;10548:2;10536:9;10527:7;10523:23;10519:32;10516:2;;;10564:1;10561;10554:12;10516:2;10599:1;10616:53;10661:7;10652:6;10641:9;10637:22;10616:53;;;10606:63;;10578:97;10510:175;;;;;10692:263;;10807:2;10795:9;10786:7;10782:23;10778:32;10775:2;;;10823:1;10820;10813:12;10775:2;10858:1;10875:64;10931:7;10922:6;10911:9;10907:22;10875:64;;;10865:74;;10837:108;10769:186;;;;;10962:382;;;11091:2;11079:9;11070:7;11066:23;11062:32;11059:2;;;11107:1;11104;11097:12;11059:2;11142:1;11159:53;11204:7;11195:6;11184:9;11180:22;11159:53;;;11149:63;;11121:97;11249:2;11267:61;11320:7;11311:6;11300:9;11296:22;11267:61;;;11257:71;;11228:106;11053:291;;;;;;11351:259;;11464:2;11452:9;11443:7;11439:23;11435:32;11432:2;;;11480:1;11477;11470:12;11432:2;11515:1;11532:62;11586:7;11577:6;11566:9;11562:22;11532:62;;;11522:72;;11494:106;11426:184;;;;;11617:132;11698:45;11737:5;11698:45;;;11693:3;11686:58;11680:69;;;11756:134;11845:39;11878:5;11845:39;;;11840:3;11833:52;11827:63;;;11897:110;11970:31;11995:5;11970:31;;;11965:3;11958:44;11952:55;;;12045:590;;12180:54;12228:5;12180:54;;;12252:6;12247:3;12240:19;12276:4;12271:3;12267:14;12260:21;;12321:56;12371:5;12321:56;;;12398:1;12383:230;12408:6;12405:1;12402:13;12383:230;;;12448:53;12497:3;12488:6;12482:13;12448:53;;;12518:60;12571:6;12518:60;;;12508:70;;12601:4;12596:3;12592:14;12585:21;;12430:1;12427;12423:9;12418:14;;12383:230;;;12387:14;12626:3;12619:10;;12159:476;;;;;;;12706:725;;12879:71;12944:5;12879:71;;;12968:6;12963:3;12956:19;12992:4;12987:3;12983:14;12976:21;;13037:73;13104:5;13037:73;;;13131:1;13116:293;13141:6;13138:1;13135:13;13116:293;;;13181:99;13276:3;13267:6;13261:13;13181:99;;;13297:77;13367:6;13297:77;;;13287:87;;13397:4;13392:3;13388:14;13381:21;;13163:1;13160;13156:9;13151:14;;13116:293;;;13120:14;13422:3;13415:10;;12858:573;;;;;;;13439:101;13506:28;13528:5;13506:28;;;13501:3;13494:41;13488:52;;;13547:110;13620:31;13645:5;13620:31;;;13615:3;13608:44;13602:55;;;13664:107;13735:30;13759:5;13735:30;;;13730:3;13723:43;13717:54;;;13778:297;;13878:38;13910:5;13878:38;;;13933:6;13928:3;13921:19;13945:63;14001:6;13994:4;13989:3;13985:14;13978:4;13971:5;13967:16;13945:63;;;14040:29;14062:6;14040:29;;;14033:4;14028:3;14024:14;14020:50;14013:57;;13858:217;;;;;;14082:300;;14184:39;14217:5;14184:39;;;14240:6;14235:3;14228:19;14252:63;14308:6;14301:4;14296:3;14292:14;14285:4;14278:5;14274:16;14252:63;;;14347:29;14369:6;14347:29;;;14340:4;14335:3;14331:14;14327:50;14320:57;;14164:218;;;;;;14390:296;;14545:2;14540:3;14533:15;14582:66;14577:2;14572:3;14568:12;14561:88;14677:2;14672:3;14668:12;14661:19;;14526:160;;;;14695:397;;14850:2;14845:3;14838:15;14887:66;14882:2;14877:3;14873:12;14866:88;14988:66;14983:2;14978:3;14974:12;14967:88;15083:2;15078:3;15074:12;15067:19;;14831:261;;;;15101:296;;15256:2;15251:3;15244:15;15293:66;15288:2;15283:3;15279:12;15272:88;15388:2;15383:3;15379:12;15372:19;;15237:160;;;;15406:296;;15561:2;15556:3;15549:15;15598:66;15593:2;15588:3;15584:12;15577:88;15693:2;15688:3;15684:12;15677:19;;15542:160;;;;15711:397;;15866:2;15861:3;15854:15;15903:66;15898:2;15893:3;15889:12;15882:88;16004:66;15999:2;15994:3;15990:12;15983:88;16099:2;16094:3;16090:12;16083:19;;15847:261;;;;16117:296;;16272:2;16267:3;16260:15;16309:66;16304:2;16299:3;16295:12;16288:88;16404:2;16399:3;16395:12;16388:19;;16253:160;;;;16422:397;;16577:2;16572:3;16565:15;16614:66;16609:2;16604:3;16600:12;16593:88;16715:66;16710:2;16705:3;16701:12;16694:88;16810:2;16805:3;16801:12;16794:19;;16558:261;;;;16828:397;;16983:2;16978:3;16971:15;17020:66;17015:2;17010:3;17006:12;16999:88;17121:66;17116:2;17111:3;17107:12;17100:88;17216:2;17211:3;17207:12;17200:19;;16964:261;;;;17234:296;;17389:2;17384:3;17377:15;17426:66;17421:2;17416:3;17412:12;17405:88;17521:2;17516:3;17512:12;17505:19;;17370:160;;;;17539:296;;17694:2;17689:3;17682:15;17731:66;17726:2;17721:3;17717:12;17710:88;17826:2;17821:3;17817:12;17810:19;;17675:160;;;;17844:296;;17999:2;17994:3;17987:15;18036:66;18031:2;18026:3;18022:12;18015:88;18131:2;18126:3;18122:12;18115:19;;17980:160;;;;18149:397;;18304:2;18299:3;18292:15;18341:66;18336:2;18331:3;18327:12;18320:88;18442:66;18437:2;18432:3;18428:12;18421:88;18537:2;18532:3;18528:12;18521:19;;18285:261;;;;18555:397;;18710:2;18705:3;18698:15;18747:66;18742:2;18737:3;18733:12;18726:88;18848:66;18843:2;18838:3;18834:12;18827:88;18943:2;18938:3;18934:12;18927:19;;18691:261;;;;18961:296;;19116:2;19111:3;19104:15;19153:66;19148:2;19143:3;19139:12;19132:88;19248:2;19243:3;19239:12;19232:19;;19097:160;;;;19266:296;;19421:2;19416:3;19409:15;19458:66;19453:2;19448:3;19444:12;19437:88;19553:2;19548:3;19544:12;19537:19;;19402:160;;;;19571:397;;19726:2;19721:3;19714:15;19763:66;19758:2;19753:3;19749:12;19742:88;19864:66;19859:2;19854:3;19850:12;19843:88;19959:2;19954:3;19950:12;19943:19;;19707:261;;;;19977:296;;20132:2;20127:3;20120:15;20169:66;20164:2;20159:3;20155:12;20148:88;20264:2;20259:3;20255:12;20248:19;;20113:160;;;;20282:397;;20437:2;20432:3;20425:15;20474:66;20469:2;20464:3;20460:12;20453:88;20575:66;20570:2;20565:3;20561:12;20554:88;20670:2;20665:3;20661:12;20654:19;;20418:261;;;;20688:397;;20843:2;20838:3;20831:15;20880:66;20875:2;20870:3;20866:12;20859:88;20981:66;20976:2;20971:3;20967:12;20960:88;21076:2;21071:3;21067:12;21060:19;;20824:261;;;;21094:296;;21249:2;21244:3;21237:15;21286:66;21281:2;21276:3;21272:12;21265:88;21381:2;21376:3;21372:12;21365:19;;21230:160;;;;21399:296;;21554:2;21549:3;21542:15;21591:66;21586:2;21581:3;21577:12;21570:88;21686:2;21681:3;21677:12;21670:19;;21535:160;;;;21704:296;;21859:2;21854:3;21847:15;21896:66;21891:2;21886:3;21882:12;21875:88;21991:2;21986:3;21982:12;21975:19;;21840:160;;;;22009:296;;22164:2;22159:3;22152:15;22201:66;22196:2;22191:3;22187:12;22180:88;22296:2;22291:3;22287:12;22280:19;;22145:160;;;;22314:296;;22469:2;22464:3;22457:15;22506:66;22501:2;22496:3;22492:12;22485:88;22601:2;22596:3;22592:12;22585:19;;22450:160;;;;22619:296;;22774:2;22769:3;22762:15;22811:66;22806:2;22801:3;22797:12;22790:88;22906:2;22901:3;22897:12;22890:19;;22755:160;;;;22924:296;;23079:2;23074:3;23067:15;23116:66;23111:2;23106:3;23102:12;23095:88;23211:2;23206:3;23202:12;23195:19;;23060:160;;;;23229:296;;23384:2;23379:3;23372:15;23421:66;23416:2;23411:3;23407:12;23400:88;23516:2;23511:3;23507:12;23500:19;;23365:160;;;;23590:490;23719:4;23714:3;23710:14;23805:3;23798:5;23794:15;23788:22;23822:61;23878:3;23873;23869:13;23856:11;23822:61;;;23739:156;23973:4;23966:5;23962:16;23956:23;23991:62;24047:4;24042:3;24038:14;24025:11;23991:62;;;23905:160;23692:388;;;;24140:643;;24279:4;24274:3;24270:14;24365:3;24358:5;24354:15;24348:22;24382:61;24438:3;24433;24429:13;24416:11;24382:61;;;24299:156;24534:4;24527:5;24523:16;24517:23;24585:3;24579:4;24575:14;24568:4;24563:3;24559:14;24552:38;24605:140;24740:4;24727:11;24605:140;;;24597:148;;24465:292;24774:4;24767:11;;24252:531;;;;;;24790:110;24863:31;24888:5;24863:31;;;24858:3;24851:44;24845:55;;;24907:107;24978:30;25002:5;24978:30;;;24973:3;24966:43;24960:54;;;25021:193;;25129:2;25118:9;25114:18;25106:26;;25143:61;25201:1;25190:9;25186:17;25177:6;25143:61;;;25100:114;;;;;25221:209;;25337:2;25326:9;25322:18;25314:26;;25351:69;25417:1;25406:9;25402:17;25393:6;25351:69;;;25308:122;;;;;25437:290;;25571:2;25560:9;25556:18;25548:26;;25585:61;25643:1;25632:9;25628:17;25619:6;25585:61;;;25657:60;25713:2;25702:9;25698:18;25689:6;25657:60;;;25542:185;;;;;;25734:341;;25892:2;25881:9;25877:18;25869:26;;25942:9;25936:4;25932:20;25928:1;25917:9;25913:17;25906:47;25967:98;26060:4;26051:6;25967:98;;;25959:106;;25863:212;;;;;26082:181;;26184:2;26173:9;26169:18;26161:26;;26198:55;26250:1;26239:9;26235:17;26226:6;26198:55;;;26155:108;;;;;26270:193;;26378:2;26367:9;26363:18;26355:26;;26392:61;26450:1;26439:9;26435:17;26426:6;26392:61;;;26349:114;;;;;26470:277;;26596:2;26585:9;26581:18;26573:26;;26646:9;26640:4;26636:20;26632:1;26621:9;26617:17;26610:47;26671:66;26732:4;26723:6;26671:66;;;26663:74;;26567:180;;;;;26754:281;;26882:2;26871:9;26867:18;26859:26;;26932:9;26926:4;26922:20;26918:1;26907:9;26903:17;26896:47;26957:68;27020:4;27011:6;26957:68;;;26949:76;;26853:182;;;;;27042:387;;27223:2;27212:9;27208:18;27200:26;;27273:9;27267:4;27263:20;27259:1;27248:9;27244:17;27237:47;27298:121;27414:4;27298:121;;;27290:129;;27194:235;;;;27436:387;;27617:2;27606:9;27602:18;27594:26;;27667:9;27661:4;27657:20;27653:1;27642:9;27638:17;27631:47;27692:121;27808:4;27692:121;;;27684:129;;27588:235;;;;27830:387;;28011:2;28000:9;27996:18;27988:26;;28061:9;28055:4;28051:20;28047:1;28036:9;28032:17;28025:47;28086:121;28202:4;28086:121;;;28078:129;;27982:235;;;;28224:387;;28405:2;28394:9;28390:18;28382:26;;28455:9;28449:4;28445:20;28441:1;28430:9;28426:17;28419:47;28480:121;28596:4;28480:121;;;28472:129;;28376:235;;;;28618:387;;28799:2;28788:9;28784:18;28776:26;;28849:9;28843:4;28839:20;28835:1;28824:9;28820:17;28813:47;28874:121;28990:4;28874:121;;;28866:129;;28770:235;;;;29012:387;;29193:2;29182:9;29178:18;29170:26;;29243:9;29237:4;29233:20;29229:1;29218:9;29214:17;29207:47;29268:121;29384:4;29268:121;;;29260:129;;29164:235;;;;29406:387;;29587:2;29576:9;29572:18;29564:26;;29637:9;29631:4;29627:20;29623:1;29612:9;29608:17;29601:47;29662:121;29778:4;29662:121;;;29654:129;;29558:235;;;;29800:387;;29981:2;29970:9;29966:18;29958:26;;30031:9;30025:4;30021:20;30017:1;30006:9;30002:17;29995:47;30056:121;30172:4;30056:121;;;30048:129;;29952:235;;;;30194:387;;30375:2;30364:9;30360:18;30352:26;;30425:9;30419:4;30415:20;30411:1;30400:9;30396:17;30389:47;30450:121;30566:4;30450:121;;;30442:129;;30346:235;;;;30588:387;;30769:2;30758:9;30754:18;30746:26;;30819:9;30813:4;30809:20;30805:1;30794:9;30790:17;30783:47;30844:121;30960:4;30844:121;;;30836:129;;30740:235;;;;30982:387;;31163:2;31152:9;31148:18;31140:26;;31213:9;31207:4;31203:20;31199:1;31188:9;31184:17;31177:47;31238:121;31354:4;31238:121;;;31230:129;;31134:235;;;;31376:387;;31557:2;31546:9;31542:18;31534:26;;31607:9;31601:4;31597:20;31593:1;31582:9;31578:17;31571:47;31632:121;31748:4;31632:121;;;31624:129;;31528:235;;;;31770:387;;31951:2;31940:9;31936:18;31928:26;;32001:9;31995:4;31991:20;31987:1;31976:9;31972:17;31965:47;32026:121;32142:4;32026:121;;;32018:129;;31922:235;;;;32164:387;;32345:2;32334:9;32330:18;32322:26;;32395:9;32389:4;32385:20;32381:1;32370:9;32366:17;32359:47;32420:121;32536:4;32420:121;;;32412:129;;32316:235;;;;32558:387;;32739:2;32728:9;32724:18;32716:26;;32789:9;32783:4;32779:20;32775:1;32764:9;32760:17;32753:47;32814:121;32930:4;32814:121;;;32806:129;;32710:235;;;;32952:387;;33133:2;33122:9;33118:18;33110:26;;33183:9;33177:4;33173:20;33169:1;33158:9;33154:17;33147:47;33208:121;33324:4;33208:121;;;33200:129;;33104:235;;;;33346:387;;33527:2;33516:9;33512:18;33504:26;;33577:9;33571:4;33567:20;33563:1;33552:9;33548:17;33541:47;33602:121;33718:4;33602:121;;;33594:129;;33498:235;;;;33740:387;;33921:2;33910:9;33906:18;33898:26;;33971:9;33965:4;33961:20;33957:1;33946:9;33942:17;33935:47;33996:121;34112:4;33996:121;;;33988:129;;33892:235;;;;34134:387;;34315:2;34304:9;34300:18;34292:26;;34365:9;34359:4;34355:20;34351:1;34340:9;34336:17;34329:47;34390:121;34506:4;34390:121;;;34382:129;;34286:235;;;;34528:387;;34709:2;34698:9;34694:18;34686:26;;34759:9;34753:4;34749:20;34745:1;34734:9;34730:17;34723:47;34784:121;34900:4;34784:121;;;34776:129;;34680:235;;;;34922:387;;35103:2;35092:9;35088:18;35080:26;;35153:9;35147:4;35143:20;35139:1;35128:9;35124:17;35117:47;35178:121;35294:4;35178:121;;;35170:129;;35074:235;;;;35316:387;;35497:2;35486:9;35482:18;35474:26;;35547:9;35541:4;35537:20;35533:1;35522:9;35518:17;35511:47;35572:121;35688:4;35572:121;;;35564:129;;35468:235;;;;35710:387;;35891:2;35880:9;35876:18;35868:26;;35941:9;35935:4;35931:20;35927:1;35916:9;35912:17;35905:47;35966:121;36082:4;35966:121;;;35958:129;;35862:235;;;;36104:387;;36285:2;36274:9;36270:18;36262:26;;36335:9;36329:4;36325:20;36321:1;36310:9;36306:17;36299:47;36360:121;36476:4;36360:121;;;36352:129;;36256:235;;;;36498:387;;36679:2;36668:9;36664:18;36656:26;;36729:9;36723:4;36719:20;36715:1;36704:9;36700:17;36693:47;36754:121;36870:4;36754:121;;;36746:129;;36650:235;;;;36892:387;;37073:2;37062:9;37058:18;37050:26;;37123:9;37117:4;37113:20;37109:1;37098:9;37094:17;37087:47;37148:121;37264:4;37148:121;;;37140:129;;37044:235;;;;37286:387;;37467:2;37456:9;37452:18;37444:26;;37517:9;37511:4;37507:20;37503:1;37492:9;37488:17;37481:47;37542:121;37658:4;37542:121;;;37534:129;;37438:235;;;;37680:337;;37836:2;37825:9;37821:18;37813:26;;37886:9;37880:4;37876:20;37872:1;37861:9;37857:17;37850:47;37911:96;38002:4;37993:6;37911:96;;;37903:104;;37807:210;;;;;38024:193;;38132:2;38121:9;38117:18;38109:26;;38146:61;38204:1;38193:9;38189:17;38180:6;38146:61;;;38103:114;;;;;38224:294;;38360:2;38349:9;38345:18;38337:26;;38374:61;38432:1;38421:9;38417:17;38408:6;38374:61;;;38446:62;38504:2;38493:9;38489:18;38480:6;38446:62;;;38331:187;;;;;;38525:326;;38677:2;38666:9;38662:18;38654:26;;38691:61;38749:1;38738:9;38734:17;38725:6;38691:61;;;38763:78;38837:2;38826:9;38822:18;38813:6;38763:78;;;38648:203;;;;;;38858:378;;39012:2;39001:9;38997:18;38989:26;;39026:61;39084:1;39073:9;39069:17;39060:6;39026:61;;;39135:9;39129:4;39125:20;39120:2;39109:9;39105:18;39098:48;39160:66;39221:4;39212:6;39160:66;;;39152:74;;38983:253;;;;;;39243:189;;39349:2;39338:9;39334:18;39326:26;;39363:59;39419:1;39408:9;39404:17;39395:6;39363:59;;;39320:112;;;;;39439:256;;39501:2;39495:9;39485:19;;39539:4;39531:6;39527:17;39638:6;39626:10;39623:22;39602:18;39590:10;39587:34;39584:62;39581:2;;;39659:1;39656;39649:12;39581:2;39679:10;39675:2;39668:22;39479:216;;;;;39702:258;;39861:18;39853:6;39850:30;39847:2;;;39893:1;39890;39883:12;39847:2;39922:4;39914:6;39910:17;39902:25;;39950:4;39944;39940:15;39932:23;;39784:176;;;;39967:258;;40110:18;40102:6;40099:30;40096:2;;;40142:1;40139;40132:12;40096:2;40186:4;40182:9;40175:4;40167:6;40163:17;40159:33;40151:41;;40215:4;40209;40205:15;40197:23;;40033:192;;;;40234:121;;40343:4;40335:6;40331:17;40320:28;;40312:43;;;;40366:138;;40492:4;40484:6;40480:17;40469:28;;40461:43;;;;40513:107;;40609:5;40603:12;40593:22;;40587:33;;;;40627:124;;40740:5;40734:12;40724:22;;40718:33;;;;40758:91;;40838:5;40832:12;40822:22;;40816:33;;;;40856:92;;40937:5;40931:12;40921:22;;40915:33;;;;40956:122;;41067:4;41059:6;41055:17;41044:28;;41037:41;;;;41087:139;;41215:4;41207:6;41203:17;41192:28;;41185:41;;;;41234:105;;41303:31;41328:5;41303:31;;;41292:42;;41286:53;;;;41346:113;;41423:31;41448:5;41423:31;;;41412:42;;41406:53;;;;41466:92;;41546:5;41539:13;41532:21;41521:32;;41515:43;;;;41565:79;;41634:5;41623:16;;41617:27;;;;41651:151;;41730:66;41723:5;41719:78;41708:89;;41702:100;;;;41809:128;;41889:42;41882:5;41878:54;41867:65;;41861:76;;;;41944:79;;42013:5;42002:16;;41996:27;;;;42030:97;;42109:12;42102:5;42098:24;42087:35;;42081:46;;;;42134:105;;42203:31;42228:5;42203:31;;;42192:42;;42186:53;;;;42246:113;;42323:31;42348:5;42323:31;;;42312:42;;42306:53;;;;42366:92;;42446:5;42439:13;42432:21;42421:32;;42415:43;;;;42465:79;;42534:5;42523:16;;42517:27;;;;42551:91;;42630:6;42623:5;42619:18;42608:29;;42602:40;;;;42649:79;;42718:5;42707:16;;42701:27;;;;42735:88;;42813:4;42806:5;42802:16;42791:27;;42785:38;;;;42830:129;;42917:37;42948:5;42917:37;;;42904:50;;42898:61;;;;42966:121;;43045:37;43076:5;43045:37;;;43032:50;;43026:61;;;;43094:115;;43173:31;43198:5;43173:31;;;43160:44;;43154:55;;;;43217:145;43298:6;43293:3;43288;43275:30;43354:1;43345:6;43340:3;43336:16;43329:27;43268:94;;;;43371:268;43436:1;43443:101;43457:6;43454:1;43451:13;43443:101;;;43533:1;43528:3;43524:11;43518:18;43514:1;43509:3;43505:11;43498:39;43479:2;43476:1;43472:10;43467:15;;43443:101;;;43559:6;43556:1;43553:13;43550:2;;;43624:1;43615:6;43610:3;43606:16;43599:27;43550:2;43420:219;;;;;43647:97;;43735:2;43731:7;43726:2;43719:5;43715:14;43711:28;43701:38;;43695:49;;;";
var abi = [
	{
		constant: false,
		inputs: [
			{
				name: "amt",
				type: "uint256"
			},
			{
				name: "dest",
				type: "address"
			}
		],
		name: "withdraw",
		outputs: [
		],
		payable: false,
		stateMutability: "nonpayable",
		type: "function"
	},
	{
		constant: true,
		inputs: [
		],
		name: "gsnMaxCallsPerDay",
		outputs: [
			{
				name: "",
				type: "uint40"
			}
		],
		payable: false,
		stateMutability: "view",
		type: "function"
	},
	{
		constant: true,
		inputs: [
			{
				name: "key",
				type: "bytes32"
			}
		],
		name: "checkDataKey",
		outputs: [
			{
				name: "",
				type: "bool"
			}
		],
		payable: false,
		stateMutability: "view",
		type: "function"
	},
	{
		constant: true,
		inputs: [
		],
		name: "getTables",
		outputs: [
			{
				name: "",
				type: "bytes32[]"
			}
		],
		payable: false,
		stateMutability: "view",
		type: "function"
	},
	{
		constant: false,
		inputs: [
			{
				name: "idTableKey",
				type: "bytes32"
			}
		],
		name: "getRowOwner",
		outputs: [
			{
				name: "rowOwner",
				type: "address"
			},
			{
				name: "createdDate",
				type: "bytes4"
			}
		],
		payable: false,
		stateMutability: "nonpayable",
		type: "function"
	},
	{
		constant: false,
		inputs: [
			{
				name: "tableName",
				type: "bytes32"
			},
			{
				name: "tableKey",
				type: "bytes32"
			},
			{
				name: "permission",
				type: "uint8"
			},
			{
				name: "_columnName",
				type: "bytes32[]"
			},
			{
				name: "_columnDtype",
				type: "bytes32[]"
			}
		],
		name: "createTable",
		outputs: [
		],
		payable: false,
		stateMutability: "nonpayable",
		type: "function"
	},
	{
		constant: true,
		inputs: [
		],
		name: "getGSNBalance",
		outputs: [
			{
				name: "",
				type: "uint256"
			}
		],
		payable: false,
		stateMutability: "view",
		type: "function"
	},
	{
		constant: false,
		inputs: [
			{
				name: "tableKey",
				type: "bytes32"
			},
			{
				name: "idKey",
				type: "bytes32"
			},
			{
				name: "fieldKey",
				type: "bytes32"
			},
			{
				name: "id",
				type: "bytes32"
			},
			{
				name: "val",
				type: "bytes"
			}
		],
		name: "insertValVar",
		outputs: [
		],
		payable: false,
		stateMutability: "nonpayable",
		type: "function"
	},
	{
		constant: true,
		inputs: [
		],
		name: "schemasTables",
		outputs: [
			{
				name: "",
				type: "bytes32"
			}
		],
		payable: false,
		stateMutability: "view",
		type: "function"
	},
	{
		constant: true,
		inputs: [
			{
				name: "",
				type: "bytes32"
			}
		],
		name: "gsnCounter",
		outputs: [
			{
				name: "",
				type: "uint256"
			}
		],
		payable: false,
		stateMutability: "view",
		type: "function"
	},
	{
		constant: true,
		inputs: [
			{
				name: "fieldIdTableKey",
				type: "bytes32"
			}
		],
		name: "getRowValue",
		outputs: [
			{
				name: "",
				type: "bytes32"
			}
		],
		payable: false,
		stateMutability: "view",
		type: "function"
	},
	{
		constant: false,
		inputs: [
		],
		name: "renounceOwnership",
		outputs: [
		],
		payable: false,
		stateMutability: "nonpayable",
		type: "function"
	},
	{
		constant: true,
		inputs: [
		],
		name: "getHubAddr",
		outputs: [
			{
				name: "",
				type: "address"
			}
		],
		payable: false,
		stateMutability: "view",
		type: "function"
	},
	{
		constant: false,
		inputs: [
			{
				name: "tableKey",
				type: "bytes32"
			},
			{
				name: "idKey",
				type: "bytes32"
			},
			{
				name: "fieldKey",
				type: "bytes32"
			},
			{
				name: "id",
				type: "bytes32"
			},
			{
				name: "val",
				type: "bytes32"
			}
		],
		name: "updateVal",
		outputs: [
		],
		payable: false,
		stateMutability: "nonpayable",
		type: "function"
	},
	{
		constant: false,
		inputs: [
			{
				name: "context",
				type: "bytes"
			}
		],
		name: "preRelayedCall",
		outputs: [
			{
				name: "",
				type: "bytes32"
			}
		],
		payable: false,
		stateMutability: "nonpayable",
		type: "function"
	},
	{
		constant: false,
		inputs: [
		],
		name: "initialize",
		outputs: [
		],
		payable: false,
		stateMutability: "nonpayable",
		type: "function"
	},
	{
		constant: false,
		inputs: [
			{
				name: "tableKey",
				type: "bytes32"
			},
			{
				name: "idKey",
				type: "bytes32"
			},
			{
				name: "id",
				type: "bytes32"
			}
		],
		name: "deleteRow",
		outputs: [
		],
		payable: false,
		stateMutability: "nonpayable",
		type: "function"
	},
	{
		constant: true,
		inputs: [
			{
				name: "relay",
				type: "address"
			},
			{
				name: "from",
				type: "address"
			},
			{
				name: "encodedFunction",
				type: "bytes"
			},
			{
				name: "transactionFee",
				type: "uint256"
			},
			{
				name: "gasPrice",
				type: "uint256"
			},
			{
				name: "gasLimit",
				type: "uint256"
			},
			{
				name: "nonce",
				type: "uint256"
			},
			{
				name: "approvalData",
				type: "bytes"
			},
			{
				name: "maxPossibleCharge",
				type: "uint256"
			}
		],
		name: "acceptRelayedCall",
		outputs: [
			{
				name: "",
				type: "uint256"
			},
			{
				name: "",
				type: "bytes"
			}
		],
		payable: false,
		stateMutability: "view",
		type: "function"
	},
	{
		constant: false,
		inputs: [
			{
				name: "tableKey",
				type: "bytes32"
			},
			{
				name: "idKey",
				type: "bytes32"
			},
			{
				name: "fieldKey",
				type: "bytes32"
			},
			{
				name: "id",
				type: "bytes32"
			}
		],
		name: "deleteVal",
		outputs: [
		],
		payable: false,
		stateMutability: "nonpayable",
		type: "function"
	},
	{
		constant: true,
		inputs: [
		],
		name: "owner",
		outputs: [
			{
				name: "",
				type: "address"
			}
		],
		payable: false,
		stateMutability: "view",
		type: "function"
	},
	{
		constant: true,
		inputs: [
		],
		name: "isOwner",
		outputs: [
			{
				name: "",
				type: "bool"
			}
		],
		payable: false,
		stateMutability: "view",
		type: "function"
	},
	{
		constant: true,
		inputs: [
			{
				name: "_name",
				type: "bytes32"
			}
		],
		name: "getSchema",
		outputs: [
			{
				components: [
					{
						name: "name",
						type: "bytes32"
					},
					{
						components: [
							{
								name: "name",
								type: "bytes32"
							},
							{
								name: "_dtype",
								type: "bytes32"
							}
						],
						name: "columns",
						type: "tuple[]"
					}
				],
				name: "",
				type: "tuple"
			}
		],
		payable: false,
		stateMutability: "view",
		type: "function"
	},
	{
		constant: true,
		inputs: [
		],
		name: "relayHubVersion",
		outputs: [
			{
				name: "",
				type: "string"
			}
		],
		payable: false,
		stateMutability: "view",
		type: "function"
	},
	{
		constant: false,
		inputs: [
			{
				name: "tableKey",
				type: "bytes32"
			},
			{
				name: "idKey",
				type: "bytes32"
			},
			{
				name: "fieldKey",
				type: "bytes32"
			},
			{
				name: "id",
				type: "bytes32"
			},
			{
				name: "val",
				type: "bytes32"
			}
		],
		name: "insertVal",
		outputs: [
		],
		payable: false,
		stateMutability: "nonpayable",
		type: "function"
	},
	{
		constant: false,
		inputs: [
			{
				name: "max",
				type: "uint256"
			}
		],
		name: "setGsnMaxCallsPerDay",
		outputs: [
		],
		payable: false,
		stateMutability: "nonpayable",
		type: "function"
	},
	{
		constant: true,
		inputs: [
			{
				name: "tableKey",
				type: "bytes32"
			}
		],
		name: "getTableIds",
		outputs: [
			{
				name: "",
				type: "bytes32[]"
			}
		],
		payable: false,
		stateMutability: "view",
		type: "function"
	},
	{
		constant: false,
		inputs: [
			{
				name: "sender",
				type: "address"
			}
		],
		name: "initialize",
		outputs: [
		],
		payable: false,
		stateMutability: "nonpayable",
		type: "function"
	},
	{
		constant: true,
		inputs: [
		],
		name: "dateTimeAddr",
		outputs: [
			{
				name: "",
				type: "address"
			}
		],
		payable: false,
		stateMutability: "view",
		type: "function"
	},
	{
		constant: true,
		inputs: [
			{
				name: "_tableKey",
				type: "bytes32"
			}
		],
		name: "getTableMetadata",
		outputs: [
			{
				name: "permission",
				type: "uint256"
			},
			{
				name: "delegate",
				type: "address"
			}
		],
		payable: false,
		stateMutability: "view",
		type: "function"
	},
	{
		constant: false,
		inputs: [
			{
				name: "context",
				type: "bytes"
			},
			{
				name: "success",
				type: "bool"
			},
			{
				name: "actualCharge",
				type: "uint256"
			},
			{
				name: "preRetVal",
				type: "bytes32"
			}
		],
		name: "postRelayedCall",
		outputs: [
		],
		payable: false,
		stateMutability: "nonpayable",
		type: "function"
	},
	{
		constant: true,
		inputs: [
			{
				name: "fieldIdTableKey",
				type: "bytes32"
			}
		],
		name: "getRowValueVar",
		outputs: [
			{
				name: "",
				type: "bytes"
			}
		],
		payable: false,
		stateMutability: "view",
		type: "function"
	},
	{
		constant: false,
		inputs: [
			{
				name: "tableName",
				type: "bytes32"
			},
			{
				name: "tableKey",
				type: "bytes32"
			}
		],
		name: "deleteTable",
		outputs: [
		],
		payable: false,
		stateMutability: "nonpayable",
		type: "function"
	},
	{
		constant: true,
		inputs: [
			{
				name: "tableKey",
				type: "bytes32"
			},
			{
				name: "id",
				type: "bytes32"
			}
		],
		name: "getIdExists",
		outputs: [
			{
				name: "",
				type: "bool"
			}
		],
		payable: false,
		stateMutability: "view",
		type: "function"
	},
	{
		constant: false,
		inputs: [
			{
				name: "newOwner",
				type: "address"
			}
		],
		name: "transferOwnership",
		outputs: [
		],
		payable: false,
		stateMutability: "nonpayable",
		type: "function"
	},
	{
		constant: false,
		inputs: [
			{
				name: "dest",
				type: "address"
			}
		],
		name: "withdrawAll",
		outputs: [
			{
				name: "",
				type: "uint256"
			}
		],
		payable: false,
		stateMutability: "nonpayable",
		type: "function"
	},
	{
		payable: true,
		stateMutability: "payable",
		type: "fallback"
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: true,
				name: "_id",
				type: "bytes32"
			},
			{
				indexed: true,
				name: "_tableKey",
				type: "bytes32"
			},
			{
				indexed: true,
				name: "_rowOwner",
				type: "address"
			}
		],
		name: "InsertRow",
		type: "event"
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: true,
				name: "oldRelayHub",
				type: "address"
			},
			{
				indexed: true,
				name: "newRelayHub",
				type: "address"
			}
		],
		name: "RelayHubChanged",
		type: "event"
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: true,
				name: "previousOwner",
				type: "address"
			},
			{
				indexed: true,
				name: "newOwner",
				type: "address"
			}
		],
		name: "OwnershipTransferred",
		type: "event"
	}
];
var ast = {
	absolutePath: "contracts/ELAJSStore.sol",
	exportedSymbols: {
		DateTime: [
			956
		],
		ELAJSStore: [
			2289
		]
	},
	id: 2290,
	nodeType: "SourceUnit",
	nodes: [
		{
			id: 927,
			literals: [
				"solidity",
				"^",
				"0.5",
				".0"
			],
			nodeType: "PragmaDirective",
			src: "0:23:2"
		},
		{
			id: 928,
			literals: [
				"experimental",
				"ABIEncoderV2"
			],
			nodeType: "PragmaDirective",
			src: "24:33:2"
		},
		{
			absolutePath: "sol-datastructs/src/contracts/PolymorphicDictionaryLib.sol",
			file: "sol-datastructs/src/contracts/PolymorphicDictionaryLib.sol",
			id: 929,
			nodeType: "ImportDirective",
			scope: 2290,
			sourceUnit: 8987,
			src: "59:68:2",
			symbolAliases: [
			],
			unitAlias: ""
		},
		{
			absolutePath: "sol-datastructs/src/contracts/Bytes32SetDictionaryLib.sol",
			file: "sol-datastructs/src/contracts/Bytes32SetDictionaryLib.sol",
			id: 930,
			nodeType: "ImportDirective",
			scope: 2290,
			sourceUnit: 6547,
			src: "197:67:2",
			symbolAliases: [
			],
			unitAlias: ""
		},
		{
			absolutePath: "sol-sql/src/contracts/src/structs/TableLib.sol",
			file: "sol-sql/src/contracts/src/structs/TableLib.sol",
			id: 931,
			nodeType: "ImportDirective",
			scope: 2290,
			sourceUnit: 10994,
			src: "313:56:2",
			symbolAliases: [
			],
			unitAlias: ""
		},
		{
			absolutePath: "contracts/ozEla/OwnableELA.sol",
			file: "./ozEla/OwnableELA.sol",
			id: 932,
			nodeType: "ImportDirective",
			scope: 2290,
			sourceUnit: 5077,
			src: "371:32:2",
			symbolAliases: [
			],
			unitAlias: ""
		},
		{
			absolutePath: "contracts/gsnEla/GSNRecipientELA.sol",
			file: "./gsnEla/GSNRecipientELA.sol",
			id: 933,
			nodeType: "ImportDirective",
			scope: 2290,
			sourceUnit: 3756,
			src: "404:38:2",
			symbolAliases: [
			],
			unitAlias: ""
		},
		{
			absolutePath: "contracts/gsnEla/IRelayHubELA.sol",
			file: "./gsnEla/IRelayHubELA.sol",
			id: 934,
			nodeType: "ImportDirective",
			scope: 2290,
			sourceUnit: 4009,
			src: "443:35:2",
			symbolAliases: [
			],
			unitAlias: ""
		},
		{
			baseContracts: [
			],
			contractDependencies: [
			],
			contractKind: "contract",
			documentation: null,
			fullyImplemented: false,
			id: 956,
			linearizedBaseContracts: [
				956
			],
			name: "DateTime",
			nodeType: "ContractDefinition",
			nodes: [
				{
					body: null,
					documentation: null,
					id: 941,
					implemented: false,
					kind: "function",
					modifiers: [
					],
					name: "getYear",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 937,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 936,
								name: "timestamp",
								nodeType: "VariableDeclaration",
								scope: 941,
								src: "521:14:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_uint256",
									typeString: "uint256"
								},
								typeName: {
									id: 935,
									name: "uint",
									nodeType: "ElementaryTypeName",
									src: "521:4:2",
									typeDescriptions: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "520:16:2"
					},
					returnParameters: {
						id: 940,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 939,
								name: "",
								nodeType: "VariableDeclaration",
								scope: 941,
								src: "558:6:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_uint16",
									typeString: "uint16"
								},
								typeName: {
									id: 938,
									name: "uint16",
									nodeType: "ElementaryTypeName",
									src: "558:6:2",
									typeDescriptions: {
										typeIdentifier: "t_uint16",
										typeString: "uint16"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "557:8:2"
					},
					scope: 956,
					src: "504:62:2",
					stateMutability: "pure",
					superFunction: null,
					visibility: "public"
				},
				{
					body: null,
					documentation: null,
					id: 948,
					implemented: false,
					kind: "function",
					modifiers: [
					],
					name: "getMonth",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 944,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 943,
								name: "timestamp",
								nodeType: "VariableDeclaration",
								scope: 948,
								src: "589:14:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_uint256",
									typeString: "uint256"
								},
								typeName: {
									id: 942,
									name: "uint",
									nodeType: "ElementaryTypeName",
									src: "589:4:2",
									typeDescriptions: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "588:16:2"
					},
					returnParameters: {
						id: 947,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 946,
								name: "",
								nodeType: "VariableDeclaration",
								scope: 948,
								src: "626:5:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_uint8",
									typeString: "uint8"
								},
								typeName: {
									id: 945,
									name: "uint8",
									nodeType: "ElementaryTypeName",
									src: "626:5:2",
									typeDescriptions: {
										typeIdentifier: "t_uint8",
										typeString: "uint8"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "625:7:2"
					},
					scope: 956,
					src: "571:62:2",
					stateMutability: "pure",
					superFunction: null,
					visibility: "public"
				},
				{
					body: null,
					documentation: null,
					id: 955,
					implemented: false,
					kind: "function",
					modifiers: [
					],
					name: "getDay",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 951,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 950,
								name: "timestamp",
								nodeType: "VariableDeclaration",
								scope: 955,
								src: "654:14:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_uint256",
									typeString: "uint256"
								},
								typeName: {
									id: 949,
									name: "uint",
									nodeType: "ElementaryTypeName",
									src: "654:4:2",
									typeDescriptions: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "653:16:2"
					},
					returnParameters: {
						id: 954,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 953,
								name: "",
								nodeType: "VariableDeclaration",
								scope: 955,
								src: "691:5:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_uint8",
									typeString: "uint8"
								},
								typeName: {
									id: 952,
									name: "uint8",
									nodeType: "ElementaryTypeName",
									src: "691:5:2",
									typeDescriptions: {
										typeIdentifier: "t_uint8",
										typeString: "uint8"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "690:7:2"
					},
					scope: 956,
					src: "638:60:2",
					stateMutability: "pure",
					superFunction: null,
					visibility: "public"
				}
			],
			scope: 2290,
			src: "480:220:2"
		},
		{
			baseContracts: [
				{
					"arguments": null,
					baseName: {
						contractScope: null,
						id: 957,
						name: "OwnableELA",
						nodeType: "UserDefinedTypeName",
						referencedDeclaration: 5076,
						src: "805:10:2",
						typeDescriptions: {
							typeIdentifier: "t_contract$_OwnableELA_$5076",
							typeString: "contract OwnableELA"
						}
					},
					id: 958,
					nodeType: "InheritanceSpecifier",
					src: "805:10:2"
				},
				{
					"arguments": null,
					baseName: {
						contractScope: null,
						id: 959,
						name: "GSNRecipientELA",
						nodeType: "UserDefinedTypeName",
						referencedDeclaration: 3755,
						src: "817:15:2",
						typeDescriptions: {
							typeIdentifier: "t_contract$_GSNRecipientELA_$3755",
							typeString: "contract GSNRecipientELA"
						}
					},
					id: 960,
					nodeType: "InheritanceSpecifier",
					src: "817:15:2"
				}
			],
			contractDependencies: [
				3692,
				3755,
				4059,
				4209,
				4883,
				4952,
				5076
			],
			contractKind: "contract",
			documentation: null,
			fullyImplemented: true,
			id: 2289,
			linearizedBaseContracts: [
				2289,
				3755,
				4209,
				3692,
				4059,
				5076,
				4883,
				4952
			],
			name: "ELAJSStore",
			nodeType: "ContractDefinition",
			nodes: [
				{
					constant: false,
					id: 963,
					name: "dateTimeAddr",
					nodeType: "VariableDeclaration",
					scope: 2289,
					src: "988:72:2",
					stateVariable: true,
					storageLocation: "default",
					typeDescriptions: {
						typeIdentifier: "t_address",
						typeString: "address"
					},
					typeName: {
						id: 961,
						name: "address",
						nodeType: "ElementaryTypeName",
						src: "988:7:2",
						stateMutability: "nonpayable",
						typeDescriptions: {
							typeIdentifier: "t_address",
							typeString: "address"
						}
					},
					value: {
						argumentTypes: null,
						hexValue: "307865393832453436326230393438353046313241463934643231443437306532316245394430453943",
						id: 962,
						isConstant: false,
						isLValue: false,
						isPure: true,
						kind: "number",
						lValueRequested: false,
						nodeType: "Literal",
						src: "1018:42:2",
						subdenomination: null,
						typeDescriptions: {
							typeIdentifier: "t_address_payable",
							typeString: "address payable"
						},
						value: "0xe982E462b094850F12AF94d21D470e21bE9D0E9C"
					},
					visibility: "public"
				},
				{
					constant: false,
					id: 968,
					name: "dateTime",
					nodeType: "VariableDeclaration",
					scope: 2289,
					src: "1262:42:2",
					stateVariable: true,
					storageLocation: "default",
					typeDescriptions: {
						typeIdentifier: "t_contract$_DateTime_$956",
						typeString: "contract DateTime"
					},
					typeName: {
						contractScope: null,
						id: 964,
						name: "DateTime",
						nodeType: "UserDefinedTypeName",
						referencedDeclaration: 956,
						src: "1262:8:2",
						typeDescriptions: {
							typeIdentifier: "t_contract$_DateTime_$956",
							typeString: "contract DateTime"
						}
					},
					value: {
						argumentTypes: null,
						"arguments": [
							{
								argumentTypes: null,
								id: 966,
								name: "dateTimeAddr",
								nodeType: "Identifier",
								overloadedDeclarations: [
								],
								referencedDeclaration: 963,
								src: "1291:12:2",
								typeDescriptions: {
									typeIdentifier: "t_address",
									typeString: "address"
								}
							}
						],
						expression: {
							argumentTypes: [
								{
									typeIdentifier: "t_address",
									typeString: "address"
								}
							],
							id: 965,
							name: "DateTime",
							nodeType: "Identifier",
							overloadedDeclarations: [
							],
							referencedDeclaration: 956,
							src: "1282:8:2",
							typeDescriptions: {
								typeIdentifier: "t_type$_t_contract$_DateTime_$956_$",
								typeString: "type(contract DateTime)"
							}
						},
						id: 967,
						isConstant: false,
						isLValue: false,
						isPure: false,
						kind: "typeConversion",
						lValueRequested: false,
						names: [
						],
						nodeType: "FunctionCall",
						src: "1282:22:2",
						typeDescriptions: {
							typeIdentifier: "t_contract$_DateTime_$956",
							typeString: "contract DateTime"
						}
					},
					visibility: "internal"
				},
				{
					constant: false,
					id: 972,
					name: "gsnCounter",
					nodeType: "VariableDeclaration",
					scope: 2289,
					src: "1549:45:2",
					stateVariable: true,
					storageLocation: "default",
					typeDescriptions: {
						typeIdentifier: "t_mapping$_t_bytes32_$_t_uint256_$",
						typeString: "mapping(bytes32 => uint256)"
					},
					typeName: {
						id: 971,
						keyType: {
							id: 969,
							name: "bytes32",
							nodeType: "ElementaryTypeName",
							src: "1557:7:2",
							typeDescriptions: {
								typeIdentifier: "t_bytes32",
								typeString: "bytes32"
							}
						},
						nodeType: "Mapping",
						src: "1549:27:2",
						typeDescriptions: {
							typeIdentifier: "t_mapping$_t_bytes32_$_t_uint256_$",
							typeString: "mapping(bytes32 => uint256)"
						},
						valueType: {
							id: 970,
							name: "uint256",
							nodeType: "ElementaryTypeName",
							src: "1568:7:2",
							typeDescriptions: {
								typeIdentifier: "t_uint256",
								typeString: "uint256"
							}
						}
					},
					value: null,
					visibility: "public"
				},
				{
					constant: false,
					id: 974,
					name: "gsnMaxCallsPerDay",
					nodeType: "VariableDeclaration",
					scope: 2289,
					src: "1653:31:2",
					stateVariable: true,
					storageLocation: "default",
					typeDescriptions: {
						typeIdentifier: "t_uint40",
						typeString: "uint40"
					},
					typeName: {
						id: 973,
						name: "uint40",
						nodeType: "ElementaryTypeName",
						src: "1653:6:2",
						typeDescriptions: {
							typeIdentifier: "t_uint40",
							typeString: "uint40"
						}
					},
					value: null,
					visibility: "public"
				},
				{
					id: 977,
					libraryName: {
						contractScope: null,
						id: 975,
						name: "PolymorphicDictionaryLib",
						nodeType: "UserDefinedTypeName",
						referencedDeclaration: 8986,
						src: "1697:24:2",
						typeDescriptions: {
							typeIdentifier: "t_contract$_PolymorphicDictionaryLib_$8986",
							typeString: "library PolymorphicDictionaryLib"
						}
					},
					nodeType: "UsingForDirective",
					src: "1691:82:2",
					typeName: {
						contractScope: null,
						id: 976,
						name: "PolymorphicDictionaryLib.PolymorphicDictionary",
						nodeType: "UserDefinedTypeName",
						referencedDeclaration: 7490,
						src: "1726:46:2",
						typeDescriptions: {
							typeIdentifier: "t_struct$_PolymorphicDictionary_$7490_storage_ptr",
							typeString: "struct PolymorphicDictionaryLib.PolymorphicDictionary"
						}
					}
				},
				{
					id: 980,
					libraryName: {
						contractScope: null,
						id: 978,
						name: "Bytes32SetDictionaryLib",
						nodeType: "UserDefinedTypeName",
						referencedDeclaration: 6546,
						src: "1784:23:2",
						typeDescriptions: {
							typeIdentifier: "t_contract$_Bytes32SetDictionaryLib_$6546",
							typeString: "library Bytes32SetDictionaryLib"
						}
					},
					nodeType: "UsingForDirective",
					src: "1778:79:2",
					typeName: {
						contractScope: null,
						id: 979,
						name: "Bytes32SetDictionaryLib.Bytes32SetDictionary",
						nodeType: "UserDefinedTypeName",
						referencedDeclaration: 6250,
						src: "1812:44:2",
						typeDescriptions: {
							typeIdentifier: "t_struct$_Bytes32SetDictionary_$6250_storage_ptr",
							typeString: "struct Bytes32SetDictionaryLib.Bytes32SetDictionary"
						}
					}
				},
				{
					constant: false,
					id: 984,
					name: "_table",
					nodeType: "VariableDeclaration",
					scope: 2289,
					src: "2115:43:2",
					stateVariable: true,
					storageLocation: "default",
					typeDescriptions: {
						typeIdentifier: "t_mapping$_t_bytes32_$_t_bytes32_$",
						typeString: "mapping(bytes32 => bytes32)"
					},
					typeName: {
						id: 983,
						keyType: {
							id: 981,
							name: "bytes32",
							nodeType: "ElementaryTypeName",
							src: "2123:7:2",
							typeDescriptions: {
								typeIdentifier: "t_bytes32",
								typeString: "bytes32"
							}
						},
						nodeType: "Mapping",
						src: "2115:27:2",
						typeDescriptions: {
							typeIdentifier: "t_mapping$_t_bytes32_$_t_bytes32_$",
							typeString: "mapping(bytes32 => bytes32)"
						},
						valueType: {
							id: 982,
							name: "bytes32",
							nodeType: "ElementaryTypeName",
							src: "2134:7:2",
							typeDescriptions: {
								typeIdentifier: "t_bytes32",
								typeString: "bytes32"
							}
						}
					},
					value: null,
					visibility: "internal"
				},
				{
					constant: false,
					id: 986,
					name: "tableId",
					nodeType: "VariableDeclaration",
					scope: 2289,
					src: "2251:61:2",
					stateVariable: true,
					storageLocation: "default",
					typeDescriptions: {
						typeIdentifier: "t_struct$_Bytes32SetDictionary_$6250_storage",
						typeString: "struct Bytes32SetDictionaryLib.Bytes32SetDictionary"
					},
					typeName: {
						contractScope: null,
						id: 985,
						name: "Bytes32SetDictionaryLib.Bytes32SetDictionary",
						nodeType: "UserDefinedTypeName",
						referencedDeclaration: 6250,
						src: "2251:44:2",
						typeDescriptions: {
							typeIdentifier: "t_struct$_Bytes32SetDictionary_$6250_storage_ptr",
							typeString: "struct Bytes32SetDictionaryLib.Bytes32SetDictionary"
						}
					},
					value: null,
					visibility: "internal"
				},
				{
					id: 989,
					libraryName: {
						contractScope: null,
						id: 987,
						name: "TableLib",
						nodeType: "UserDefinedTypeName",
						referencedDeclaration: 10993,
						src: "2408:8:2",
						typeDescriptions: {
							typeIdentifier: "t_contract$_TableLib_$10993",
							typeString: "library TableLib"
						}
					},
					nodeType: "UsingForDirective",
					src: "2402:34:2",
					typeName: {
						contractScope: null,
						id: 988,
						name: "TableLib.Table",
						nodeType: "UserDefinedTypeName",
						referencedDeclaration: 10758,
						src: "2421:14:2",
						typeDescriptions: {
							typeIdentifier: "t_struct$_Table_$10758_storage_ptr",
							typeString: "struct TableLib.Table"
						}
					}
				},
				{
					id: 992,
					libraryName: {
						contractScope: null,
						id: 990,
						name: "TableLib",
						nodeType: "UserDefinedTypeName",
						referencedDeclaration: 10993,
						src: "2447:8:2",
						typeDescriptions: {
							typeIdentifier: "t_contract$_TableLib_$10993",
							typeString: "library TableLib"
						}
					},
					nodeType: "UsingForDirective",
					src: "2441:25:2",
					typeName: {
						id: 991,
						name: "bytes",
						nodeType: "ElementaryTypeName",
						src: "2460:5:2",
						typeDescriptions: {
							typeIdentifier: "t_bytes_storage_ptr",
							typeString: "bytes"
						}
					}
				},
				{
					constant: true,
					id: 995,
					name: "schemasTables",
					nodeType: "VariableDeclaration",
					scope: 2289,
					src: "2628:106:2",
					stateVariable: true,
					storageLocation: "default",
					typeDescriptions: {
						typeIdentifier: "t_bytes32",
						typeString: "bytes32"
					},
					typeName: {
						id: 993,
						name: "bytes32",
						nodeType: "ElementaryTypeName",
						src: "2628:7:2",
						typeDescriptions: {
							typeIdentifier: "t_bytes32",
							typeString: "bytes32"
						}
					},
					value: {
						argumentTypes: null,
						hexValue: "307837333633363836353664363137333265373037353632366336393633326537343631363236633635373330303030303030303030303030303030303030303030",
						id: 994,
						isConstant: false,
						isLValue: false,
						isPure: true,
						kind: "number",
						lValueRequested: false,
						nodeType: "Literal",
						src: "2668:66:2",
						subdenomination: null,
						typeDescriptions: {
							typeIdentifier: "t_rational_52191615962582502679176554766158760808305166966340223837583177329853989912576_by_1",
							typeString: "int_const 5219...(69 digits omitted)...2576"
						},
						value: "0x736368656d61732e7075626c69632e7461626c65730000000000000000000000"
					},
					visibility: "public"
				},
				{
					constant: false,
					id: 997,
					name: "database",
					nodeType: "VariableDeclaration",
					scope: 2289,
					src: "3009:64:2",
					stateVariable: true,
					storageLocation: "default",
					typeDescriptions: {
						typeIdentifier: "t_struct$_PolymorphicDictionary_$7490_storage",
						typeString: "struct PolymorphicDictionaryLib.PolymorphicDictionary"
					},
					typeName: {
						contractScope: null,
						id: 996,
						name: "PolymorphicDictionaryLib.PolymorphicDictionary",
						nodeType: "UserDefinedTypeName",
						referencedDeclaration: 7490,
						src: "3009:46:2",
						typeDescriptions: {
							typeIdentifier: "t_struct$_PolymorphicDictionary_$7490_storage_ptr",
							typeString: "struct PolymorphicDictionaryLib.PolymorphicDictionary"
						}
					},
					value: null,
					visibility: "internal"
				},
				{
					body: {
						id: 1017,
						nodeType: "Block",
						src: "3221:111:2",
						statements: [
							{
								expression: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											expression: {
												argumentTypes: null,
												id: 1005,
												name: "msg",
												nodeType: "Identifier",
												overloadedDeclarations: [
												],
												referencedDeclaration: 11008,
												src: "3253:3:2",
												typeDescriptions: {
													typeIdentifier: "t_magic_message",
													typeString: "msg"
												}
											},
											id: 1006,
											isConstant: false,
											isLValue: false,
											isPure: false,
											lValueRequested: false,
											memberName: "sender",
											nodeType: "MemberAccess",
											referencedDeclaration: null,
											src: "3253:10:2",
											typeDescriptions: {
												typeIdentifier: "t_address_payable",
												typeString: "address payable"
											}
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_address_payable",
												typeString: "address payable"
											}
										],
										expression: {
											argumentTypes: null,
											id: 1002,
											name: "OwnableELA",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 5076,
											src: "3231:10:2",
											typeDescriptions: {
												typeIdentifier: "t_type$_t_contract$_OwnableELA_$5076_$",
												typeString: "type(contract OwnableELA)"
											}
										},
										id: 1004,
										isConstant: false,
										isLValue: false,
										isPure: false,
										lValueRequested: false,
										memberName: "initialize",
										nodeType: "MemberAccess",
										referencedDeclaration: 4987,
										src: "3231:21:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_nonpayable$_t_address_$returns$__$",
											typeString: "function (address)"
										}
									},
									id: 1007,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "3231:33:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 1008,
								nodeType: "ExpressionStatement",
								src: "3231:33:2"
							},
							{
								expression: {
									argumentTypes: null,
									"arguments": [
									],
									expression: {
										argumentTypes: [
										],
										expression: {
											argumentTypes: null,
											id: 1009,
											name: "GSNRecipientELA",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 3755,
											src: "3274:15:2",
											typeDescriptions: {
												typeIdentifier: "t_type$_t_contract$_GSNRecipientELA_$3755_$",
												typeString: "type(contract GSNRecipientELA)"
											}
										},
										id: 1011,
										isConstant: false,
										isLValue: false,
										isPure: false,
										lValueRequested: false,
										memberName: "initialize",
										nodeType: "MemberAccess",
										referencedDeclaration: 3718,
										src: "3274:26:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_nonpayable$__$returns$__$",
											typeString: "function ()"
										}
									},
									id: 1012,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "3274:28:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 1013,
								nodeType: "ExpressionStatement",
								src: "3274:28:2"
							},
							{
								expression: {
									argumentTypes: null,
									"arguments": [
									],
									expression: {
										argumentTypes: [
										],
										id: 1014,
										name: "_initialize",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 1035,
										src: "3312:11:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_nonpayable$__$returns$__$",
											typeString: "function ()"
										}
									},
									id: 1015,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "3312:13:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 1016,
								nodeType: "ExpressionStatement",
								src: "3312:13:2"
							}
						]
					},
					documentation: null,
					id: 1018,
					implemented: true,
					kind: "function",
					modifiers: [
						{
							"arguments": null,
							id: 1000,
							modifierName: {
								argumentTypes: null,
								id: 999,
								name: "initializer",
								nodeType: "Identifier",
								overloadedDeclarations: [
								],
								referencedDeclaration: 4927,
								src: "3209:11:2",
								typeDescriptions: {
									typeIdentifier: "t_modifier$__$",
									typeString: "modifier ()"
								}
							},
							nodeType: "ModifierInvocation",
							src: "3209:11:2"
						}
					],
					name: "initialize",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 998,
						nodeType: "ParameterList",
						parameters: [
						],
						src: "3199:2:2"
					},
					returnParameters: {
						id: 1001,
						nodeType: "ParameterList",
						parameters: [
						],
						src: "3221:0:2"
					},
					scope: 2289,
					src: "3180:152:2",
					stateMutability: "nonpayable",
					superFunction: 3718,
					visibility: "public"
				},
				{
					body: {
						id: 1034,
						nodeType: "Block",
						src: "3370:247:2",
						statements: [
							{
								expression: {
									argumentTypes: null,
									id: 1023,
									isConstant: false,
									isLValue: false,
									isPure: false,
									lValueRequested: false,
									leftHandSide: {
										argumentTypes: null,
										id: 1021,
										name: "gsnMaxCallsPerDay",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 974,
										src: "3380:17:2",
										typeDescriptions: {
											typeIdentifier: "t_uint40",
											typeString: "uint40"
										}
									},
									nodeType: "Assignment",
									operator: "=",
									rightHandSide: {
										argumentTypes: null,
										hexValue: "31303030",
										id: 1022,
										isConstant: false,
										isLValue: false,
										isPure: true,
										kind: "number",
										lValueRequested: false,
										nodeType: "Literal",
										src: "3400:4:2",
										subdenomination: null,
										typeDescriptions: {
											typeIdentifier: "t_rational_1000_by_1",
											typeString: "int_const 1000"
										},
										value: "1000"
									},
									src: "3380:24:2",
									typeDescriptions: {
										typeIdentifier: "t_uint40",
										typeString: "uint40"
									}
								},
								id: 1024,
								nodeType: "ExpressionStatement",
								src: "3380:24:2"
							},
							{
								expression: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1028,
											name: "schemasTables",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 995,
											src: "3540:13:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										{
											argumentTypes: null,
											expression: {
												argumentTypes: null,
												expression: {
													argumentTypes: null,
													id: 1029,
													name: "PolymorphicDictionaryLib",
													nodeType: "Identifier",
													overloadedDeclarations: [
													],
													referencedDeclaration: 8986,
													src: "3555:24:2",
													typeDescriptions: {
														typeIdentifier: "t_type$_t_contract$_PolymorphicDictionaryLib_$8986_$",
														typeString: "type(library PolymorphicDictionaryLib)"
													}
												},
												id: 1030,
												isConstant: false,
												isLValue: false,
												isPure: false,
												lValueRequested: false,
												memberName: "DictionaryType",
												nodeType: "MemberAccess",
												referencedDeclaration: 7495,
												src: "3555:39:2",
												typeDescriptions: {
													typeIdentifier: "t_type$_t_enum$_DictionaryType_$7495_$",
													typeString: "type(enum PolymorphicDictionaryLib.DictionaryType)"
												}
											},
											id: 1031,
											isConstant: false,
											isLValue: false,
											isPure: true,
											lValueRequested: false,
											memberName: "OneToManyFixed",
											nodeType: "MemberAccess",
											referencedDeclaration: null,
											src: "3555:54:2",
											typeDescriptions: {
												typeIdentifier: "t_enum$_DictionaryType_$7495",
												typeString: "enum PolymorphicDictionaryLib.DictionaryType"
											}
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											},
											{
												typeIdentifier: "t_enum$_DictionaryType_$7495",
												typeString: "enum PolymorphicDictionaryLib.DictionaryType"
											}
										],
										expression: {
											argumentTypes: null,
											id: 1025,
											name: "database",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 997,
											src: "3524:8:2",
											typeDescriptions: {
												typeIdentifier: "t_struct$_PolymorphicDictionary_$7490_storage",
												typeString: "struct PolymorphicDictionaryLib.PolymorphicDictionary storage ref"
											}
										},
										id: 1027,
										isConstant: false,
										isLValue: true,
										isPure: false,
										lValueRequested: false,
										memberName: "addKey",
										nodeType: "MemberAccess",
										referencedDeclaration: 8913,
										src: "3524:15:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_nonpayable$_t_struct$_PolymorphicDictionary_$7490_storage_ptr_$_t_bytes32_$_t_enum$_DictionaryType_$7495_$returns$_t_bool_$bound_to$_t_struct$_PolymorphicDictionary_$7490_storage_ptr_$",
											typeString: "function (struct PolymorphicDictionaryLib.PolymorphicDictionary storage pointer,bytes32,enum PolymorphicDictionaryLib.DictionaryType) returns (bool)"
										}
									},
									id: 1032,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "3524:86:2",
									typeDescriptions: {
										typeIdentifier: "t_bool",
										typeString: "bool"
									}
								},
								id: 1033,
								nodeType: "ExpressionStatement",
								src: "3524:86:2"
							}
						]
					},
					documentation: null,
					id: 1035,
					implemented: true,
					kind: "function",
					modifiers: [
					],
					name: "_initialize",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 1019,
						nodeType: "ParameterList",
						parameters: [
						],
						src: "3358:2:2"
					},
					returnParameters: {
						id: 1020,
						nodeType: "ParameterList",
						parameters: [
						],
						src: "3370:0:2"
					},
					scope: 2289,
					src: "3338:279:2",
					stateMutability: "nonpayable",
					superFunction: null,
					visibility: "internal"
				},
				{
					body: {
						id: 1102,
						nodeType: "Block",
						src: "4136:886:2",
						statements: [
							{
								expression: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											commonType: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											},
											id: 1057,
											isConstant: false,
											isLValue: false,
											isPure: false,
											lValueRequested: false,
											leftExpression: {
												argumentTypes: null,
												baseExpression: {
													argumentTypes: null,
													id: 1053,
													name: "_table",
													nodeType: "Identifier",
													overloadedDeclarations: [
													],
													referencedDeclaration: 984,
													src: "4430:6:2",
													typeDescriptions: {
														typeIdentifier: "t_mapping$_t_bytes32_$_t_bytes32_$",
														typeString: "mapping(bytes32 => bytes32)"
													}
												},
												id: 1055,
												indexExpression: {
													argumentTypes: null,
													id: 1054,
													name: "tableKey",
													nodeType: "Identifier",
													overloadedDeclarations: [
													],
													referencedDeclaration: 1039,
													src: "4437:8:2",
													typeDescriptions: {
														typeIdentifier: "t_bytes32",
														typeString: "bytes32"
													}
												},
												isConstant: false,
												isLValue: true,
												isPure: false,
												lValueRequested: false,
												nodeType: "IndexAccess",
												src: "4430:16:2",
												typeDescriptions: {
													typeIdentifier: "t_bytes32",
													typeString: "bytes32"
												}
											},
											nodeType: "BinaryOperation",
											operator: "==",
											rightExpression: {
												argumentTypes: null,
												hexValue: "30",
												id: 1056,
												isConstant: false,
												isLValue: false,
												isPure: true,
												kind: "number",
												lValueRequested: false,
												nodeType: "Literal",
												src: "4450:1:2",
												subdenomination: null,
												typeDescriptions: {
													typeIdentifier: "t_rational_0_by_1",
													typeString: "int_const 0"
												},
												value: "0"
											},
											src: "4430:21:2",
											typeDescriptions: {
												typeIdentifier: "t_bool",
												typeString: "bool"
											}
										},
										{
											argumentTypes: null,
											hexValue: "5461626c6520616c726561647920657869737473",
											id: 1058,
											isConstant: false,
											isLValue: false,
											isPure: true,
											kind: "string",
											lValueRequested: false,
											nodeType: "Literal",
											src: "4453:22:2",
											subdenomination: null,
											typeDescriptions: {
												typeIdentifier: "t_stringliteral_d8add126c0ed6d6d0798bb02d3c7c3567f9ff0247b5ed07dd21088b6700efbaf",
												typeString: "literal_string \"Table already exists\""
											},
											value: "Table already exists"
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bool",
												typeString: "bool"
											},
											{
												typeIdentifier: "t_stringliteral_d8add126c0ed6d6d0798bb02d3c7c3567f9ff0247b5ed07dd21088b6700efbaf",
												typeString: "literal_string \"Table already exists\""
											}
										],
										id: 1052,
										name: "require",
										nodeType: "Identifier",
										overloadedDeclarations: [
											11011,
											11012
										],
										referencedDeclaration: 11012,
										src: "4422:7:2",
										typeDescriptions: {
											typeIdentifier: "t_function_require_pure$_t_bool_$_t_string_memory_ptr_$returns$__$",
											typeString: "function (bool,string memory) pure"
										}
									},
									id: 1059,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "4422:54:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 1060,
								nodeType: "ExpressionStatement",
								src: "4422:54:2"
							},
							{
								assignments: [
									1062
								],
								declarations: [
									{
										constant: false,
										id: 1062,
										name: "delegate",
										nodeType: "VariableDeclaration",
										scope: 1102,
										src: "4487:16:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_address",
											typeString: "address"
										},
										typeName: {
											id: 1061,
											name: "address",
											nodeType: "ElementaryTypeName",
											src: "4487:7:2",
											stateMutability: "nonpayable",
											typeDescriptions: {
												typeIdentifier: "t_address",
												typeString: "address"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 1066,
								initialValue: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											hexValue: "307830",
											id: 1064,
											isConstant: false,
											isLValue: false,
											isPure: true,
											kind: "number",
											lValueRequested: false,
											nodeType: "Literal",
											src: "4514:3:2",
											subdenomination: null,
											typeDescriptions: {
												typeIdentifier: "t_rational_0_by_1",
												typeString: "int_const 0"
											},
											value: "0x0"
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_rational_0_by_1",
												typeString: "int_const 0"
											}
										],
										id: 1063,
										isConstant: false,
										isLValue: false,
										isPure: true,
										lValueRequested: false,
										nodeType: "ElementaryTypeNameExpression",
										src: "4506:7:2",
										typeDescriptions: {
											typeIdentifier: "t_type$_t_address_$",
											typeString: "type(address)"
										},
										typeName: "address"
									},
									id: 1065,
									isConstant: false,
									isLValue: false,
									isPure: true,
									kind: "typeConversion",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "4506:12:2",
									typeDescriptions: {
										typeIdentifier: "t_address_payable",
										typeString: "address payable"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "4487:31:2"
							},
							{
								expression: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1068,
											name: "tableKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1039,
											src: "4597:8:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										{
											argumentTypes: null,
											id: 1069,
											name: "permission",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1041,
											src: "4607:10:2",
											typeDescriptions: {
												typeIdentifier: "t_uint8",
												typeString: "uint8"
											}
										},
										{
											argumentTypes: null,
											id: 1070,
											name: "delegate",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1062,
											src: "4619:8:2",
											typeDescriptions: {
												typeIdentifier: "t_address",
												typeString: "address"
											}
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											},
											{
												typeIdentifier: "t_uint8",
												typeString: "uint8"
											},
											{
												typeIdentifier: "t_address",
												typeString: "address"
											}
										],
										id: 1067,
										name: "setTableMetadata",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 2038,
										src: "4580:16:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_nonpayable$_t_bytes32_$_t_uint8_$_t_address_$returns$__$",
											typeString: "function (bytes32,uint8,address)"
										}
									},
									id: 1071,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "4580:48:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 1072,
								nodeType: "ExpressionStatement",
								src: "4580:48:2"
							},
							{
								expression: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1076,
											name: "schemasTables",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 995,
											src: "4663:13:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										{
											argumentTypes: null,
											id: 1077,
											name: "tableName",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1037,
											src: "4678:9:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											},
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										],
										expression: {
											argumentTypes: null,
											id: 1073,
											name: "database",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 997,
											src: "4639:8:2",
											typeDescriptions: {
												typeIdentifier: "t_struct$_PolymorphicDictionary_$7490_storage",
												typeString: "struct PolymorphicDictionaryLib.PolymorphicDictionary storage ref"
											}
										},
										id: 1075,
										isConstant: false,
										isLValue: true,
										isPure: false,
										lValueRequested: false,
										memberName: "addValueForKey",
										nodeType: "MemberAccess",
										referencedDeclaration: 8652,
										src: "4639:23:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_nonpayable$_t_struct$_PolymorphicDictionary_$7490_storage_ptr_$_t_bytes32_$_t_bytes32_$returns$_t_bool_$bound_to$_t_struct$_PolymorphicDictionary_$7490_storage_ptr_$",
											typeString: "function (struct PolymorphicDictionaryLib.PolymorphicDictionary storage pointer,bytes32,bytes32) returns (bool)"
										}
									},
									id: 1078,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "4639:49:2",
									typeDescriptions: {
										typeIdentifier: "t_bool",
										typeString: "bool"
									}
								},
								id: 1079,
								nodeType: "ExpressionStatement",
								src: "4639:49:2"
							},
							{
								expression: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1083,
											name: "tableKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1039,
											src: "4783:8:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										],
										expression: {
											argumentTypes: null,
											id: 1080,
											name: "tableId",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 986,
											src: "4768:7:2",
											typeDescriptions: {
												typeIdentifier: "t_struct$_Bytes32SetDictionary_$6250_storage",
												typeString: "struct Bytes32SetDictionaryLib.Bytes32SetDictionary storage ref"
											}
										},
										id: 1082,
										isConstant: false,
										isLValue: true,
										isPure: false,
										lValueRequested: false,
										memberName: "addKey",
										nodeType: "MemberAccess",
										referencedDeclaration: 6266,
										src: "4768:14:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_nonpayable$_t_struct$_Bytes32SetDictionary_$6250_storage_ptr_$_t_bytes32_$returns$_t_bool_$bound_to$_t_struct$_Bytes32SetDictionary_$6250_storage_ptr_$",
											typeString: "function (struct Bytes32SetDictionaryLib.Bytes32SetDictionary storage pointer,bytes32) returns (bool)"
										}
									},
									id: 1084,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "4768:24:2",
									typeDescriptions: {
										typeIdentifier: "t_bool",
										typeString: "bool"
									}
								},
								id: 1085,
								nodeType: "ExpressionStatement",
								src: "4768:24:2"
							},
							{
								assignments: [
									1089
								],
								declarations: [
									{
										constant: false,
										id: 1089,
										name: "tableSchema",
										nodeType: "VariableDeclaration",
										scope: 1102,
										src: "4836:33:2",
										stateVariable: false,
										storageLocation: "memory",
										typeDescriptions: {
											typeIdentifier: "t_struct$_Table_$10758_memory_ptr",
											typeString: "struct TableLib.Table"
										},
										typeName: {
											contractScope: null,
											id: 1088,
											name: "TableLib.Table",
											nodeType: "UserDefinedTypeName",
											referencedDeclaration: 10758,
											src: "4836:14:2",
											typeDescriptions: {
												typeIdentifier: "t_struct$_Table_$10758_storage_ptr",
												typeString: "struct TableLib.Table"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 1096,
								initialValue: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1092,
											name: "tableName",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1037,
											src: "4901:9:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										{
											argumentTypes: null,
											id: 1093,
											name: "_columnName",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1044,
											src: "4924:11:2",
											typeDescriptions: {
												typeIdentifier: "t_array$_t_bytes32_$dyn_memory_ptr",
												typeString: "bytes32[] memory"
											}
										},
										{
											argumentTypes: null,
											id: 1094,
											name: "_columnDtype",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1047,
											src: "4949:12:2",
											typeDescriptions: {
												typeIdentifier: "t_array$_t_bytes32_$dyn_memory_ptr",
												typeString: "bytes32[] memory"
											}
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											},
											{
												typeIdentifier: "t_array$_t_bytes32_$dyn_memory_ptr",
												typeString: "bytes32[] memory"
											},
											{
												typeIdentifier: "t_array$_t_bytes32_$dyn_memory_ptr",
												typeString: "bytes32[] memory"
											}
										],
										expression: {
											argumentTypes: null,
											id: 1090,
											name: "TableLib",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 10993,
											src: "4872:8:2",
											typeDescriptions: {
												typeIdentifier: "t_type$_t_contract$_TableLib_$10993_$",
												typeString: "type(library TableLib)"
											}
										},
										id: 1091,
										isConstant: false,
										isLValue: false,
										isPure: false,
										lValueRequested: false,
										memberName: "create",
										nodeType: "MemberAccess",
										referencedDeclaration: 10858,
										src: "4872:15:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_pure$_t_bytes32_$_t_array$_t_bytes32_$dyn_memory_ptr_$_t_array$_t_bytes32_$dyn_memory_ptr_$returns$_t_struct$_Table_$10758_memory_ptr_$",
											typeString: "function (bytes32,bytes32[] memory,bytes32[] memory) pure returns (struct TableLib.Table memory)"
										}
									},
									id: 1095,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "4872:99:2",
									typeDescriptions: {
										typeIdentifier: "t_struct$_Table_$10758_memory_ptr",
										typeString: "struct TableLib.Table memory"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "4836:135:2"
							},
							{
								expression: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1098,
											name: "tableKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1039,
											src: "4993:8:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										{
											argumentTypes: null,
											id: 1099,
											name: "tableSchema",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1089,
											src: "5003:11:2",
											typeDescriptions: {
												typeIdentifier: "t_struct$_Table_$10758_memory_ptr",
												typeString: "struct TableLib.Table memory"
											}
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											},
											{
												typeIdentifier: "t_struct$_Table_$10758_memory_ptr",
												typeString: "struct TableLib.Table memory"
											}
										],
										id: 1097,
										name: "saveSchema",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 1166,
										src: "4982:10:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_nonpayable$_t_bytes32_$_t_struct$_Table_$10758_memory_ptr_$returns$_t_bool_$",
											typeString: "function (bytes32,struct TableLib.Table memory) returns (bool)"
										}
									},
									id: 1100,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "4982:33:2",
									typeDescriptions: {
										typeIdentifier: "t_bool",
										typeString: "bool"
									}
								},
								id: 1101,
								nodeType: "ExpressionStatement",
								src: "4982:33:2"
							}
						]
					},
					documentation: "@dev create a new table, only the owner may create this\n     * @param tableName right padded zeroes (Web3.utils.stringToHex)\n@param tableKey this is the namehash of tableName",
					id: 1103,
					implemented: true,
					kind: "function",
					modifiers: [
						{
							"arguments": null,
							id: 1050,
							modifierName: {
								argumentTypes: null,
								id: 1049,
								name: "onlyOwner",
								nodeType: "Identifier",
								overloadedDeclarations: [
								],
								referencedDeclaration: 5005,
								src: "4126:9:2",
								typeDescriptions: {
									typeIdentifier: "t_modifier$__$",
									typeString: "modifier ()"
								}
							},
							nodeType: "ModifierInvocation",
							src: "4126:9:2"
						}
					],
					name: "createTable",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 1048,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1037,
								name: "tableName",
								nodeType: "VariableDeclaration",
								scope: 1103,
								src: "3965:17:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1036,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "3965:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							},
							{
								constant: false,
								id: 1039,
								name: "tableKey",
								nodeType: "VariableDeclaration",
								scope: 1103,
								src: "3992:16:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1038,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "3992:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							},
							{
								constant: false,
								id: 1041,
								name: "permission",
								nodeType: "VariableDeclaration",
								scope: 1103,
								src: "4018:16:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_uint8",
									typeString: "uint8"
								},
								typeName: {
									id: 1040,
									name: "uint8",
									nodeType: "ElementaryTypeName",
									src: "4018:5:2",
									typeDescriptions: {
										typeIdentifier: "t_uint8",
										typeString: "uint8"
									}
								},
								value: null,
								visibility: "internal"
							},
							{
								constant: false,
								id: 1044,
								name: "_columnName",
								nodeType: "VariableDeclaration",
								scope: 1103,
								src: "4044:28:2",
								stateVariable: false,
								storageLocation: "memory",
								typeDescriptions: {
									typeIdentifier: "t_array$_t_bytes32_$dyn_memory_ptr",
									typeString: "bytes32[]"
								},
								typeName: {
									baseType: {
										id: 1042,
										name: "bytes32",
										nodeType: "ElementaryTypeName",
										src: "4044:7:2",
										typeDescriptions: {
											typeIdentifier: "t_bytes32",
											typeString: "bytes32"
										}
									},
									id: 1043,
									length: null,
									nodeType: "ArrayTypeName",
									src: "4044:9:2",
									typeDescriptions: {
										typeIdentifier: "t_array$_t_bytes32_$dyn_storage_ptr",
										typeString: "bytes32[]"
									}
								},
								value: null,
								visibility: "internal"
							},
							{
								constant: false,
								id: 1047,
								name: "_columnDtype",
								nodeType: "VariableDeclaration",
								scope: 1103,
								src: "4082:29:2",
								stateVariable: false,
								storageLocation: "memory",
								typeDescriptions: {
									typeIdentifier: "t_array$_t_bytes32_$dyn_memory_ptr",
									typeString: "bytes32[]"
								},
								typeName: {
									baseType: {
										id: 1045,
										name: "bytes32",
										nodeType: "ElementaryTypeName",
										src: "4082:7:2",
										typeDescriptions: {
											typeIdentifier: "t_bytes32",
											typeString: "bytes32"
										}
									},
									id: 1046,
									length: null,
									nodeType: "ArrayTypeName",
									src: "4082:9:2",
									typeDescriptions: {
										typeIdentifier: "t_array$_t_bytes32_$dyn_storage_ptr",
										typeString: "bytes32[]"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "3955:163:2"
					},
					returnParameters: {
						id: 1051,
						nodeType: "ParameterList",
						parameters: [
						],
						src: "4136:0:2"
					},
					scope: 2289,
					src: "3935:1087:2",
					stateMutability: "nonpayable",
					superFunction: null,
					visibility: "public"
				},
				{
					body: {
						id: 1131,
						nodeType: "Block",
						src: "5158:136:2",
						statements: [
							{
								expression: {
									argumentTypes: null,
									id: 1116,
									isConstant: false,
									isLValue: false,
									isPure: false,
									lValueRequested: false,
									leftHandSide: {
										argumentTypes: null,
										baseExpression: {
											argumentTypes: null,
											id: 1112,
											name: "_table",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 984,
											src: "5168:6:2",
											typeDescriptions: {
												typeIdentifier: "t_mapping$_t_bytes32_$_t_bytes32_$",
												typeString: "mapping(bytes32 => bytes32)"
											}
										},
										id: 1114,
										indexExpression: {
											argumentTypes: null,
											id: 1113,
											name: "tableKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1107,
											src: "5175:8:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										isConstant: false,
										isLValue: true,
										isPure: false,
										lValueRequested: true,
										nodeType: "IndexAccess",
										src: "5168:16:2",
										typeDescriptions: {
											typeIdentifier: "t_bytes32",
											typeString: "bytes32"
										}
									},
									nodeType: "Assignment",
									operator: "=",
									rightHandSide: {
										argumentTypes: null,
										hexValue: "30",
										id: 1115,
										isConstant: false,
										isLValue: false,
										isPure: true,
										kind: "number",
										lValueRequested: false,
										nodeType: "Literal",
										src: "5187:1:2",
										subdenomination: null,
										typeDescriptions: {
											typeIdentifier: "t_rational_0_by_1",
											typeString: "int_const 0"
										},
										value: "0"
									},
									src: "5168:20:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								id: 1117,
								nodeType: "ExpressionStatement",
								src: "5168:20:2"
							},
							{
								expression: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1121,
											name: "schemasTables",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 995,
											src: "5225:13:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										{
											argumentTypes: null,
											id: 1122,
											name: "tableName",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1105,
											src: "5240:9:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											},
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										],
										expression: {
											argumentTypes: null,
											id: 1118,
											name: "database",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 997,
											src: "5198:8:2",
											typeDescriptions: {
												typeIdentifier: "t_struct$_PolymorphicDictionary_$7490_storage",
												typeString: "struct PolymorphicDictionaryLib.PolymorphicDictionary storage ref"
											}
										},
										id: 1120,
										isConstant: false,
										isLValue: true,
										isPure: false,
										lValueRequested: false,
										memberName: "removeValueForKey",
										nodeType: "MemberAccess",
										referencedDeclaration: 8966,
										src: "5198:26:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_nonpayable$_t_struct$_PolymorphicDictionary_$7490_storage_ptr_$_t_bytes32_$_t_bytes32_$returns$_t_bool_$bound_to$_t_struct$_PolymorphicDictionary_$7490_storage_ptr_$",
											typeString: "function (struct PolymorphicDictionaryLib.PolymorphicDictionary storage pointer,bytes32,bytes32) returns (bool)"
										}
									},
									id: 1123,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "5198:52:2",
									typeDescriptions: {
										typeIdentifier: "t_bool",
										typeString: "bool"
									}
								},
								id: 1124,
								nodeType: "ExpressionStatement",
								src: "5198:52:2"
							},
							{
								expression: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1128,
											name: "tableKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1107,
											src: "5278:8:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										],
										expression: {
											argumentTypes: null,
											id: 1125,
											name: "tableId",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 986,
											src: "5260:7:2",
											typeDescriptions: {
												typeIdentifier: "t_struct$_Bytes32SetDictionary_$6250_storage",
												typeString: "struct Bytes32SetDictionaryLib.Bytes32SetDictionary storage ref"
											}
										},
										id: 1127,
										isConstant: false,
										isLValue: true,
										isPure: false,
										lValueRequested: false,
										memberName: "removeKey",
										nodeType: "MemberAccess",
										referencedDeclaration: 6379,
										src: "5260:17:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_nonpayable$_t_struct$_Bytes32SetDictionary_$6250_storage_ptr_$_t_bytes32_$returns$_t_bool_$bound_to$_t_struct$_Bytes32SetDictionary_$6250_storage_ptr_$",
											typeString: "function (struct Bytes32SetDictionaryLib.Bytes32SetDictionary storage pointer,bytes32) returns (bool)"
										}
									},
									id: 1129,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "5260:27:2",
									typeDescriptions: {
										typeIdentifier: "t_bool",
										typeString: "bool"
									}
								},
								id: 1130,
								nodeType: "ExpressionStatement",
								src: "5260:27:2"
							}
						]
					},
					documentation: null,
					id: 1132,
					implemented: true,
					kind: "function",
					modifiers: [
						{
							"arguments": null,
							id: 1110,
							modifierName: {
								argumentTypes: null,
								id: 1109,
								name: "onlyOwner",
								nodeType: "Identifier",
								overloadedDeclarations: [
								],
								referencedDeclaration: 5005,
								src: "5148:9:2",
								typeDescriptions: {
									typeIdentifier: "t_modifier$__$",
									typeString: "modifier ()"
								}
							},
							nodeType: "ModifierInvocation",
							src: "5148:9:2"
						}
					],
					name: "deleteTable",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 1108,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1105,
								name: "tableName",
								nodeType: "VariableDeclaration",
								scope: 1132,
								src: "5091:17:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1104,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "5091:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							},
							{
								constant: false,
								id: 1107,
								name: "tableKey",
								nodeType: "VariableDeclaration",
								scope: 1132,
								src: "5118:16:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1106,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "5118:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "5081:59:2"
					},
					returnParameters: {
						id: 1111,
						nodeType: "ParameterList",
						parameters: [
						],
						src: "5158:0:2"
					},
					scope: 2289,
					src: "5061:233:2",
					stateMutability: "nonpayable",
					superFunction: null,
					visibility: "public"
				},
				{
					body: {
						id: 1143,
						nodeType: "Block",
						src: "5361:77:2",
						statements: [
							{
								expression: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1140,
											name: "schemasTables",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 995,
											src: "5417:13:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										],
										expression: {
											argumentTypes: null,
											id: 1138,
											name: "database",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 997,
											src: "5378:8:2",
											typeDescriptions: {
												typeIdentifier: "t_struct$_PolymorphicDictionary_$7490_storage",
												typeString: "struct PolymorphicDictionaryLib.PolymorphicDictionary storage ref"
											}
										},
										id: 1139,
										isConstant: false,
										isLValue: true,
										isPure: false,
										lValueRequested: false,
										memberName: "enumerateForKeyOneToManyFixed",
										nodeType: "MemberAccess",
										referencedDeclaration: 7747,
										src: "5378:38:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_view$_t_struct$_PolymorphicDictionary_$7490_storage_ptr_$_t_bytes32_$returns$_t_array$_t_bytes32_$dyn_memory_ptr_$bound_to$_t_struct$_PolymorphicDictionary_$7490_storage_ptr_$",
											typeString: "function (struct PolymorphicDictionaryLib.PolymorphicDictionary storage pointer,bytes32) view returns (bytes32[] memory)"
										}
									},
									id: 1141,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "5378:53:2",
									typeDescriptions: {
										typeIdentifier: "t_array$_t_bytes32_$dyn_memory_ptr",
										typeString: "bytes32[] memory"
									}
								},
								functionReturnParameters: 1137,
								id: 1142,
								nodeType: "Return",
								src: "5371:60:2"
							}
						]
					},
					documentation: null,
					id: 1144,
					implemented: true,
					kind: "function",
					modifiers: [
					],
					name: "getTables",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 1133,
						nodeType: "ParameterList",
						parameters: [
						],
						src: "5318:2:2"
					},
					returnParameters: {
						id: 1137,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1136,
								name: "",
								nodeType: "VariableDeclaration",
								scope: 1144,
								src: "5344:16:2",
								stateVariable: false,
								storageLocation: "memory",
								typeDescriptions: {
									typeIdentifier: "t_array$_t_bytes32_$dyn_memory_ptr",
									typeString: "bytes32[]"
								},
								typeName: {
									baseType: {
										id: 1134,
										name: "bytes32",
										nodeType: "ElementaryTypeName",
										src: "5344:7:2",
										typeDescriptions: {
											typeIdentifier: "t_bytes32",
											typeString: "bytes32"
										}
									},
									id: 1135,
									length: null,
									nodeType: "ArrayTypeName",
									src: "5344:9:2",
									typeDescriptions: {
										typeIdentifier: "t_array$_t_bytes32_$dyn_storage_ptr",
										typeString: "bytes32[]"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "5343:18:2"
					},
					scope: 2289,
					src: "5300:138:2",
					stateMutability: "view",
					superFunction: null,
					visibility: "external"
				},
				{
					body: {
						id: 1165,
						nodeType: "Block",
						src: "5680:186:2",
						statements: [
							{
								assignments: [
									1154
								],
								declarations: [
									{
										constant: false,
										id: 1154,
										name: "encoded",
										nodeType: "VariableDeclaration",
										scope: 1165,
										src: "5690:20:2",
										stateVariable: false,
										storageLocation: "memory",
										typeDescriptions: {
											typeIdentifier: "t_bytes_memory_ptr",
											typeString: "bytes"
										},
										typeName: {
											id: 1153,
											name: "bytes",
											nodeType: "ElementaryTypeName",
											src: "5690:5:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes_storage_ptr",
												typeString: "bytes"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 1158,
								initialValue: {
									argumentTypes: null,
									"arguments": [
									],
									expression: {
										argumentTypes: [
										],
										expression: {
											argumentTypes: null,
											id: 1155,
											name: "tableSchema",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1148,
											src: "5713:11:2",
											typeDescriptions: {
												typeIdentifier: "t_struct$_Table_$10758_memory_ptr",
												typeString: "struct TableLib.Table memory"
											}
										},
										id: 1156,
										isConstant: false,
										isLValue: true,
										isPure: false,
										lValueRequested: false,
										memberName: "encode",
										nodeType: "MemberAccess",
										referencedDeclaration: 10910,
										src: "5713:18:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_pure$_t_struct$_Table_$10758_memory_ptr_$returns$_t_bytes_memory_ptr_$bound_to$_t_struct$_Table_$10758_memory_ptr_$",
											typeString: "function (struct TableLib.Table memory) pure returns (bytes memory)"
										}
									},
									id: 1157,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "5713:20:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes_memory_ptr",
										typeString: "bytes memory"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "5690:43:2"
							},
							{
								expression: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1161,
											name: "tableKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1146,
											src: "5841:8:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										{
											argumentTypes: null,
											id: 1162,
											name: "encoded",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1154,
											src: "5851:7:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes_memory_ptr",
												typeString: "bytes memory"
											}
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											},
											{
												typeIdentifier: "t_bytes_memory_ptr",
												typeString: "bytes memory"
											}
										],
										expression: {
											argumentTypes: null,
											id: 1159,
											name: "database",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 997,
											src: "5817:8:2",
											typeDescriptions: {
												typeIdentifier: "t_struct$_PolymorphicDictionary_$7490_storage",
												typeString: "struct PolymorphicDictionaryLib.PolymorphicDictionary storage ref"
											}
										},
										id: 1160,
										isConstant: false,
										isLValue: true,
										isPure: false,
										lValueRequested: false,
										memberName: "setValueForKey",
										nodeType: "MemberAccess",
										referencedDeclaration: 8603,
										src: "5817:23:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_nonpayable$_t_struct$_PolymorphicDictionary_$7490_storage_ptr_$_t_bytes32_$_t_bytes_memory_ptr_$returns$_t_bool_$bound_to$_t_struct$_PolymorphicDictionary_$7490_storage_ptr_$",
											typeString: "function (struct PolymorphicDictionaryLib.PolymorphicDictionary storage pointer,bytes32,bytes memory) returns (bool)"
										}
									},
									id: 1163,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "5817:42:2",
									typeDescriptions: {
										typeIdentifier: "t_bool",
										typeString: "bool"
									}
								},
								functionReturnParameters: 1152,
								id: 1164,
								nodeType: "Return",
								src: "5810:49:2"
							}
						]
					},
					documentation: null,
					id: 1166,
					implemented: true,
					kind: "function",
					modifiers: [
					],
					name: "saveSchema",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 1149,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1146,
								name: "tableKey",
								nodeType: "VariableDeclaration",
								scope: 1166,
								src: "5603:16:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1145,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "5603:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							},
							{
								constant: false,
								id: 1148,
								name: "tableSchema",
								nodeType: "VariableDeclaration",
								scope: 1166,
								src: "5621:33:2",
								stateVariable: false,
								storageLocation: "memory",
								typeDescriptions: {
									typeIdentifier: "t_struct$_Table_$10758_memory_ptr",
									typeString: "struct TableLib.Table"
								},
								typeName: {
									contractScope: null,
									id: 1147,
									name: "TableLib.Table",
									nodeType: "UserDefinedTypeName",
									referencedDeclaration: 10758,
									src: "5621:14:2",
									typeDescriptions: {
										typeIdentifier: "t_struct$_Table_$10758_storage_ptr",
										typeString: "struct TableLib.Table"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "5602:53:2"
					},
					returnParameters: {
						id: 1152,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1151,
								name: "",
								nodeType: "VariableDeclaration",
								scope: 1166,
								src: "5674:4:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bool",
									typeString: "bool"
								},
								typeName: {
									id: 1150,
									name: "bool",
									nodeType: "ElementaryTypeName",
									src: "5674:4:2",
									typeDescriptions: {
										typeIdentifier: "t_bool",
										typeString: "bool"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "5673:6:2"
					},
					scope: 2289,
					src: "5583:283:2",
					stateMutability: "nonpayable",
					superFunction: null,
					visibility: "internal"
				},
				{
					body: {
						id: 1184,
						nodeType: "Block",
						src: "5970:108:2",
						statements: [
							{
								assignments: [
									1174
								],
								declarations: [
									{
										constant: false,
										id: 1174,
										name: "encoded",
										nodeType: "VariableDeclaration",
										scope: 1184,
										src: "5980:20:2",
										stateVariable: false,
										storageLocation: "memory",
										typeDescriptions: {
											typeIdentifier: "t_bytes_memory_ptr",
											typeString: "bytes"
										},
										typeName: {
											id: 1173,
											name: "bytes",
											nodeType: "ElementaryTypeName",
											src: "5980:5:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes_storage_ptr",
												typeString: "bytes"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 1179,
								initialValue: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1177,
											name: "_name",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1168,
											src: "6027:5:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										],
										expression: {
											argumentTypes: null,
											id: 1175,
											name: "database",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 997,
											src: "6003:8:2",
											typeDescriptions: {
												typeIdentifier: "t_struct$_PolymorphicDictionary_$7490_storage",
												typeString: "struct PolymorphicDictionaryLib.PolymorphicDictionary storage ref"
											}
										},
										id: 1176,
										isConstant: false,
										isLValue: true,
										isPure: false,
										lValueRequested: false,
										memberName: "getBytesForKey",
										nodeType: "MemberAccess",
										referencedDeclaration: 8063,
										src: "6003:23:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_view$_t_struct$_PolymorphicDictionary_$7490_storage_ptr_$_t_bytes32_$returns$_t_bytes_memory_ptr_$bound_to$_t_struct$_PolymorphicDictionary_$7490_storage_ptr_$",
											typeString: "function (struct PolymorphicDictionaryLib.PolymorphicDictionary storage pointer,bytes32) view returns (bytes memory)"
										}
									},
									id: 1178,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "6003:30:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes_memory_ptr",
										typeString: "bytes memory"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "5980:53:2"
							},
							{
								expression: {
									argumentTypes: null,
									"arguments": [
									],
									expression: {
										argumentTypes: [
										],
										expression: {
											argumentTypes: null,
											id: 1180,
											name: "encoded",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1174,
											src: "6050:7:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes_memory_ptr",
												typeString: "bytes memory"
											}
										},
										id: 1181,
										isConstant: false,
										isLValue: false,
										isPure: false,
										lValueRequested: false,
										memberName: "decodeTable",
										nodeType: "MemberAccess",
										referencedDeclaration: 10959,
										src: "6050:19:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_pure$_t_bytes_memory_ptr_$returns$_t_struct$_Table_$10758_memory_ptr_$bound_to$_t_bytes_memory_ptr_$",
											typeString: "function (bytes memory) pure returns (struct TableLib.Table memory)"
										}
									},
									id: 1182,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "6050:21:2",
									typeDescriptions: {
										typeIdentifier: "t_struct$_Table_$10758_memory_ptr",
										typeString: "struct TableLib.Table memory"
									}
								},
								functionReturnParameters: 1172,
								id: 1183,
								nodeType: "Return",
								src: "6043:28:2"
							}
						]
					},
					documentation: null,
					id: 1185,
					implemented: true,
					kind: "function",
					modifiers: [
					],
					name: "getSchema",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 1169,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1168,
								name: "_name",
								nodeType: "VariableDeclaration",
								scope: 1185,
								src: "5911:13:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1167,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "5911:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "5910:15:2"
					},
					returnParameters: {
						id: 1172,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1171,
								name: "",
								nodeType: "VariableDeclaration",
								scope: 1185,
								src: "5947:21:2",
								stateVariable: false,
								storageLocation: "memory",
								typeDescriptions: {
									typeIdentifier: "t_struct$_Table_$10758_memory_ptr",
									typeString: "struct TableLib.Table"
								},
								typeName: {
									contractScope: null,
									id: 1170,
									name: "TableLib.Table",
									nodeType: "UserDefinedTypeName",
									referencedDeclaration: 10758,
									src: "5947:14:2",
									typeDescriptions: {
										typeIdentifier: "t_struct$_Table_$10758_storage_ptr",
										typeString: "struct TableLib.Table"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "5946:23:2"
					},
					scope: 2289,
					src: "5892:186:2",
					stateMutability: "view",
					superFunction: null,
					visibility: "public"
				},
				{
					body: {
						id: 1222,
						nodeType: "Block",
						src: "6280:423:2",
						statements: [
							{
								assignments: [
									1190,
									1192
								],
								declarations: [
									{
										constant: false,
										id: 1190,
										name: "permission",
										nodeType: "VariableDeclaration",
										scope: 1222,
										src: "6292:18:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										},
										typeName: {
											id: 1189,
											name: "uint256",
											nodeType: "ElementaryTypeName",
											src: "6292:7:2",
											typeDescriptions: {
												typeIdentifier: "t_uint256",
												typeString: "uint256"
											}
										},
										value: null,
										visibility: "internal"
									},
									{
										constant: false,
										id: 1192,
										name: "delegate",
										nodeType: "VariableDeclaration",
										scope: 1222,
										src: "6312:16:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_address",
											typeString: "address"
										},
										typeName: {
											id: 1191,
											name: "address",
											nodeType: "ElementaryTypeName",
											src: "6312:7:2",
											stateMutability: "nonpayable",
											typeDescriptions: {
												typeIdentifier: "t_address",
												typeString: "address"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 1196,
								initialValue: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1194,
											name: "tableKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1187,
											src: "6349:8:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										],
										id: 1193,
										name: "getTableMetadata",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 2003,
										src: "6332:16:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_view$_t_bytes32_$returns$_t_uint256_$_t_address_$",
											typeString: "function (bytes32) view returns (uint256,address)"
										}
									},
									id: 1195,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "6332:26:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$_t_uint256_$_t_address_$",
										typeString: "tuple(uint256,address)"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "6291:67:2"
							},
							{
								expression: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											commonType: {
												typeIdentifier: "t_uint256",
												typeString: "uint256"
											},
											id: 1200,
											isConstant: false,
											isLValue: false,
											isPure: false,
											lValueRequested: false,
											leftExpression: {
												argumentTypes: null,
												id: 1198,
												name: "permission",
												nodeType: "Identifier",
												overloadedDeclarations: [
												],
												referencedDeclaration: 1190,
												src: "6441:10:2",
												typeDescriptions: {
													typeIdentifier: "t_uint256",
													typeString: "uint256"
												}
											},
											nodeType: "BinaryOperation",
											operator: ">",
											rightExpression: {
												argumentTypes: null,
												hexValue: "30",
												id: 1199,
												isConstant: false,
												isLValue: false,
												isPure: true,
												kind: "number",
												lValueRequested: false,
												nodeType: "Literal",
												src: "6454:1:2",
												subdenomination: null,
												typeDescriptions: {
													typeIdentifier: "t_rational_0_by_1",
													typeString: "int_const 0"
												},
												value: "0"
											},
											src: "6441:14:2",
											typeDescriptions: {
												typeIdentifier: "t_bool",
												typeString: "bool"
											}
										},
										{
											argumentTypes: null,
											hexValue: "43616e6e6f7420494e5345525420696e746f2073797374656d207461626c65",
											id: 1201,
											isConstant: false,
											isLValue: false,
											isPure: true,
											kind: "string",
											lValueRequested: false,
											nodeType: "Literal",
											src: "6457:33:2",
											subdenomination: null,
											typeDescriptions: {
												typeIdentifier: "t_stringliteral_28f57c2279a5e7e2e4199177afe179a3b463277cc9c606809c6534b86aa50229",
												typeString: "literal_string \"Cannot INSERT into system table\""
											},
											value: "Cannot INSERT into system table"
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bool",
												typeString: "bool"
											},
											{
												typeIdentifier: "t_stringliteral_28f57c2279a5e7e2e4199177afe179a3b463277cc9c606809c6534b86aa50229",
												typeString: "literal_string \"Cannot INSERT into system table\""
											}
										],
										id: 1197,
										name: "require",
										nodeType: "Identifier",
										overloadedDeclarations: [
											11011,
											11012
										],
										referencedDeclaration: 11012,
										src: "6433:7:2",
										typeDescriptions: {
											typeIdentifier: "t_function_require_pure$_t_bool_$_t_string_memory_ptr_$returns$__$",
											typeString: "function (bool,string memory) pure"
										}
									},
									id: 1202,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "6433:58:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 1203,
								nodeType: "ExpressionStatement",
								src: "6433:58:2"
							},
							{
								expression: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											commonType: {
												typeIdentifier: "t_bool",
												typeString: "bool"
											},
											id: 1217,
											isConstant: false,
											isLValue: false,
											isPure: false,
											lValueRequested: false,
											leftExpression: {
												argumentTypes: null,
												commonType: {
													typeIdentifier: "t_bool",
													typeString: "bool"
												},
												id: 1212,
												isConstant: false,
												isLValue: false,
												isPure: false,
												lValueRequested: false,
												leftExpression: {
													argumentTypes: null,
													commonType: {
														typeIdentifier: "t_uint256",
														typeString: "uint256"
													},
													id: 1207,
													isConstant: false,
													isLValue: false,
													isPure: false,
													lValueRequested: false,
													leftExpression: {
														argumentTypes: null,
														id: 1205,
														name: "permission",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 1190,
														src: "6570:10:2",
														typeDescriptions: {
															typeIdentifier: "t_uint256",
															typeString: "uint256"
														}
													},
													nodeType: "BinaryOperation",
													operator: ">",
													rightExpression: {
														argumentTypes: null,
														hexValue: "31",
														id: 1206,
														isConstant: false,
														isLValue: false,
														isPure: true,
														kind: "number",
														lValueRequested: false,
														nodeType: "Literal",
														src: "6583:1:2",
														subdenomination: null,
														typeDescriptions: {
															typeIdentifier: "t_rational_1_by_1",
															typeString: "int_const 1"
														},
														value: "1"
													},
													src: "6570:14:2",
													typeDescriptions: {
														typeIdentifier: "t_bool",
														typeString: "bool"
													}
												},
												nodeType: "BinaryOperation",
												operator: "||",
												rightExpression: {
													argumentTypes: null,
													commonType: {
														typeIdentifier: "t_bool",
														typeString: "bool"
													},
													id: 1211,
													isConstant: false,
													isLValue: false,
													isPure: false,
													lValueRequested: false,
													leftExpression: {
														argumentTypes: null,
														"arguments": [
														],
														expression: {
															argumentTypes: [
															],
															id: 1208,
															name: "isOwner",
															nodeType: "Identifier",
															overloadedDeclarations: [
															],
															referencedDeclaration: 5016,
															src: "6588:7:2",
															typeDescriptions: {
																typeIdentifier: "t_function_internal_view$__$returns$_t_bool_$",
																typeString: "function () view returns (bool)"
															}
														},
														id: 1209,
														isConstant: false,
														isLValue: false,
														isPure: false,
														kind: "functionCall",
														lValueRequested: false,
														names: [
														],
														nodeType: "FunctionCall",
														src: "6588:9:2",
														typeDescriptions: {
															typeIdentifier: "t_bool",
															typeString: "bool"
														}
													},
													nodeType: "BinaryOperation",
													operator: "==",
													rightExpression: {
														argumentTypes: null,
														hexValue: "74727565",
														id: 1210,
														isConstant: false,
														isLValue: false,
														isPure: true,
														kind: "bool",
														lValueRequested: false,
														nodeType: "Literal",
														src: "6601:4:2",
														subdenomination: null,
														typeDescriptions: {
															typeIdentifier: "t_bool",
															typeString: "bool"
														},
														value: "true"
													},
													src: "6588:17:2",
													typeDescriptions: {
														typeIdentifier: "t_bool",
														typeString: "bool"
													}
												},
												src: "6570:35:2",
												typeDescriptions: {
													typeIdentifier: "t_bool",
													typeString: "bool"
												}
											},
											nodeType: "BinaryOperation",
											operator: "||",
											rightExpression: {
												argumentTypes: null,
												commonType: {
													typeIdentifier: "t_address",
													typeString: "address"
												},
												id: 1216,
												isConstant: false,
												isLValue: false,
												isPure: false,
												lValueRequested: false,
												leftExpression: {
													argumentTypes: null,
													id: 1213,
													name: "delegate",
													nodeType: "Identifier",
													overloadedDeclarations: [
													],
													referencedDeclaration: 1192,
													src: "6609:8:2",
													typeDescriptions: {
														typeIdentifier: "t_address",
														typeString: "address"
													}
												},
												nodeType: "BinaryOperation",
												operator: "==",
												rightExpression: {
													argumentTypes: null,
													"arguments": [
													],
													expression: {
														argumentTypes: [
														],
														id: 1214,
														name: "_msgSender",
														nodeType: "Identifier",
														overloadedDeclarations: [
															3607
														],
														referencedDeclaration: 3607,
														src: "6621:10:2",
														typeDescriptions: {
															typeIdentifier: "t_function_internal_view$__$returns$_t_address_$",
															typeString: "function () view returns (address)"
														}
													},
													id: 1215,
													isConstant: false,
													isLValue: false,
													isPure: false,
													kind: "functionCall",
													lValueRequested: false,
													names: [
													],
													nodeType: "FunctionCall",
													src: "6621:12:2",
													typeDescriptions: {
														typeIdentifier: "t_address",
														typeString: "address"
													}
												},
												src: "6609:24:2",
												typeDescriptions: {
													typeIdentifier: "t_bool",
													typeString: "bool"
												}
											},
											src: "6570:63:2",
											typeDescriptions: {
												typeIdentifier: "t_bool",
												typeString: "bool"
											}
										},
										{
											argumentTypes: null,
											hexValue: "4f6e6c79206f776e65722f64656c65676174652063616e20494e5345525420696e746f2074686973207461626c65",
											id: 1218,
											isConstant: false,
											isLValue: false,
											isPure: true,
											kind: "string",
											lValueRequested: false,
											nodeType: "Literal",
											src: "6635:48:2",
											subdenomination: null,
											typeDescriptions: {
												typeIdentifier: "t_stringliteral_8da29dab96b947ba0a45fbb38f71b63a9c8bd8e01000bc5ea24df01471fecc83",
												typeString: "literal_string \"Only owner/delegate can INSERT into this table\""
											},
											value: "Only owner/delegate can INSERT into this table"
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bool",
												typeString: "bool"
											},
											{
												typeIdentifier: "t_stringliteral_8da29dab96b947ba0a45fbb38f71b63a9c8bd8e01000bc5ea24df01471fecc83",
												typeString: "literal_string \"Only owner/delegate can INSERT into this table\""
											}
										],
										id: 1204,
										name: "require",
										nodeType: "Identifier",
										overloadedDeclarations: [
											11011,
											11012
										],
										referencedDeclaration: 11012,
										src: "6562:7:2",
										typeDescriptions: {
											typeIdentifier: "t_function_require_pure$_t_bool_$_t_string_memory_ptr_$returns$__$",
											typeString: "function (bool,string memory) pure"
										}
									},
									id: 1219,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "6562:122:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 1220,
								nodeType: "ExpressionStatement",
								src: "6562:122:2"
							},
							{
								id: 1221,
								nodeType: "PlaceholderStatement",
								src: "6695:1:2"
							}
						]
					},
					documentation: "@dev Table level permission checks",
					id: 1223,
					name: "insertCheck",
					nodeType: "ModifierDefinition",
					parameters: {
						id: 1188,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1187,
								name: "tableKey",
								nodeType: "VariableDeclaration",
								scope: 1223,
								src: "6262:16:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1186,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "6262:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "6261:18:2"
					},
					src: "6241:462:2",
					visibility: "internal"
				},
				{
					body: {
						id: 1296,
						nodeType: "Block",
						src: "7333:965:2",
						statements: [
							{
								assignments: [
									1240
								],
								declarations: [
									{
										constant: false,
										id: 1240,
										name: "idTableKey",
										nodeType: "VariableDeclaration",
										scope: 1296,
										src: "7344:18:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_bytes32",
											typeString: "bytes32"
										},
										typeName: {
											id: 1239,
											name: "bytes32",
											nodeType: "ElementaryTypeName",
											src: "7344:7:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 1245,
								initialValue: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1242,
											name: "idKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1227,
											src: "7374:5:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										{
											argumentTypes: null,
											id: 1243,
											name: "tableKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1225,
											src: "7381:8:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											},
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										],
										id: 1241,
										name: "namehash",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 1960,
										src: "7365:8:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_pure$_t_bytes32_$_t_bytes32_$returns$_t_bytes32_$",
											typeString: "function (bytes32,bytes32) pure returns (bytes32)"
										}
									},
									id: 1244,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "7365:25:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "7344:46:2"
							},
							{
								assignments: [
									1247
								],
								declarations: [
									{
										constant: false,
										id: 1247,
										name: "fieldIdTableKey",
										nodeType: "VariableDeclaration",
										scope: 1296,
										src: "7400:23:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_bytes32",
											typeString: "bytes32"
										},
										typeName: {
											id: 1246,
											name: "bytes32",
											nodeType: "ElementaryTypeName",
											src: "7400:7:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 1252,
								initialValue: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1249,
											name: "fieldKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1229,
											src: "7435:8:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										{
											argumentTypes: null,
											id: 1250,
											name: "idTableKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1240,
											src: "7445:10:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											},
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										],
										id: 1248,
										name: "namehash",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 1960,
										src: "7426:8:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_pure$_t_bytes32_$_t_bytes32_$returns$_t_bytes32_$",
											typeString: "function (bytes32,bytes32) pure returns (bytes32)"
										}
									},
									id: 1251,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "7426:30:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "7400:56:2"
							},
							{
								expression: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											commonType: {
												typeIdentifier: "t_bool",
												typeString: "bool"
											},
											id: 1259,
											isConstant: false,
											isLValue: false,
											isPure: false,
											lValueRequested: false,
											leftExpression: {
												argumentTypes: null,
												"arguments": [
													{
														argumentTypes: null,
														id: 1256,
														name: "fieldIdTableKey",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 1247,
														src: "7496:15:2",
														typeDescriptions: {
															typeIdentifier: "t_bytes32",
															typeString: "bytes32"
														}
													}
												],
												expression: {
													argumentTypes: [
														{
															typeIdentifier: "t_bytes32",
															typeString: "bytes32"
														}
													],
													expression: {
														argumentTypes: null,
														id: 1254,
														name: "database",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 997,
														src: "7475:8:2",
														typeDescriptions: {
															typeIdentifier: "t_struct$_PolymorphicDictionary_$7490_storage",
															typeString: "struct PolymorphicDictionaryLib.PolymorphicDictionary storage ref"
														}
													},
													id: 1255,
													isConstant: false,
													isLValue: true,
													isPure: false,
													lValueRequested: false,
													memberName: "containsKey",
													nodeType: "MemberAccess",
													referencedDeclaration: 7798,
													src: "7475:20:2",
													typeDescriptions: {
														typeIdentifier: "t_function_internal_view$_t_struct$_PolymorphicDictionary_$7490_storage_ptr_$_t_bytes32_$returns$_t_bool_$bound_to$_t_struct$_PolymorphicDictionary_$7490_storage_ptr_$",
														typeString: "function (struct PolymorphicDictionaryLib.PolymorphicDictionary storage pointer,bytes32) view returns (bool)"
													}
												},
												id: 1257,
												isConstant: false,
												isLValue: false,
												isPure: false,
												kind: "functionCall",
												lValueRequested: false,
												names: [
												],
												nodeType: "FunctionCall",
												src: "7475:37:2",
												typeDescriptions: {
													typeIdentifier: "t_bool",
													typeString: "bool"
												}
											},
											nodeType: "BinaryOperation",
											operator: "==",
											rightExpression: {
												argumentTypes: null,
												hexValue: "66616c7365",
												id: 1258,
												isConstant: false,
												isLValue: false,
												isPure: true,
												kind: "bool",
												lValueRequested: false,
												nodeType: "Literal",
												src: "7516:5:2",
												subdenomination: null,
												typeDescriptions: {
													typeIdentifier: "t_bool",
													typeString: "bool"
												},
												value: "false"
											},
											src: "7475:46:2",
											typeDescriptions: {
												typeIdentifier: "t_bool",
												typeString: "bool"
											}
										},
										{
											argumentTypes: null,
											hexValue: "69642b6669656c6420616c726561647920657869737473",
											id: 1260,
											isConstant: false,
											isLValue: false,
											isPure: true,
											kind: "string",
											lValueRequested: false,
											nodeType: "Literal",
											src: "7523:25:2",
											subdenomination: null,
											typeDescriptions: {
												typeIdentifier: "t_stringliteral_b47ab3ca8e2817377098c0fdb9f676216babd1393ec4fa6b120ecb6719d9fd66",
												typeString: "literal_string \"id+field already exists\""
											},
											value: "id+field already exists"
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bool",
												typeString: "bool"
											},
											{
												typeIdentifier: "t_stringliteral_b47ab3ca8e2817377098c0fdb9f676216babd1393ec4fa6b120ecb6719d9fd66",
												typeString: "literal_string \"id+field already exists\""
											}
										],
										id: 1253,
										name: "require",
										nodeType: "Identifier",
										overloadedDeclarations: [
											11011,
											11012
										],
										referencedDeclaration: 11012,
										src: "7467:7:2",
										typeDescriptions: {
											typeIdentifier: "t_function_require_pure$_t_bool_$_t_string_memory_ptr_$returns$__$",
											typeString: "function (bool,string memory) pure"
										}
									},
									id: 1261,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "7467:82:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 1262,
								nodeType: "ExpressionStatement",
								src: "7467:82:2"
							},
							{
								expression: {
									argumentTypes: null,
									"arguments": [
									],
									expression: {
										argumentTypes: [
										],
										id: 1263,
										name: "increaseGsnCounter",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 2128,
										src: "7589:18:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_nonpayable$__$returns$__$",
											typeString: "function ()"
										}
									},
									id: 1264,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "7589:20:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 1265,
								nodeType: "ExpressionStatement",
								src: "7589:20:2"
							},
							{
								expression: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1269,
											name: "tableKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1225,
											src: "7811:8:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										{
											argumentTypes: null,
											id: 1270,
											name: "id",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1231,
											src: "7821:2:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											},
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										],
										expression: {
											argumentTypes: null,
											id: 1266,
											name: "tableId",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 986,
											src: "7788:7:2",
											typeDescriptions: {
												typeIdentifier: "t_struct$_Bytes32SetDictionary_$6250_storage",
												typeString: "struct Bytes32SetDictionaryLib.Bytes32SetDictionary storage ref"
											}
										},
										id: 1268,
										isConstant: false,
										isLValue: true,
										isPure: false,
										lValueRequested: false,
										memberName: "addValueForKey",
										nodeType: "MemberAccess",
										referencedDeclaration: 6354,
										src: "7788:22:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_nonpayable$_t_struct$_Bytes32SetDictionary_$6250_storage_ptr_$_t_bytes32_$_t_bytes32_$returns$_t_bool_$bound_to$_t_struct$_Bytes32SetDictionary_$6250_storage_ptr_$",
											typeString: "function (struct Bytes32SetDictionaryLib.Bytes32SetDictionary storage pointer,bytes32,bytes32) returns (bool)"
										}
									},
									id: 1271,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "7788:36:2",
									typeDescriptions: {
										typeIdentifier: "t_bool",
										typeString: "bool"
									}
								},
								id: 1272,
								nodeType: "ExpressionStatement",
								src: "7788:36:2"
							},
							{
								condition: {
									argumentTypes: null,
									commonType: {
										typeIdentifier: "t_bool",
										typeString: "bool"
									},
									id: 1278,
									isConstant: false,
									isLValue: false,
									isPure: false,
									lValueRequested: false,
									leftExpression: {
										argumentTypes: null,
										"arguments": [
											{
												argumentTypes: null,
												id: 1275,
												name: "idTableKey",
												nodeType: "Identifier",
												overloadedDeclarations: [
												],
												referencedDeclaration: 1240,
												src: "7971:10:2",
												typeDescriptions: {
													typeIdentifier: "t_bytes32",
													typeString: "bytes32"
												}
											}
										],
										expression: {
											argumentTypes: [
												{
													typeIdentifier: "t_bytes32",
													typeString: "bytes32"
												}
											],
											expression: {
												argumentTypes: null,
												id: 1273,
												name: "database",
												nodeType: "Identifier",
												overloadedDeclarations: [
												],
												referencedDeclaration: 997,
												src: "7950:8:2",
												typeDescriptions: {
													typeIdentifier: "t_struct$_PolymorphicDictionary_$7490_storage",
													typeString: "struct PolymorphicDictionaryLib.PolymorphicDictionary storage ref"
												}
											},
											id: 1274,
											isConstant: false,
											isLValue: true,
											isPure: false,
											lValueRequested: false,
											memberName: "containsKey",
											nodeType: "MemberAccess",
											referencedDeclaration: 7798,
											src: "7950:20:2",
											typeDescriptions: {
												typeIdentifier: "t_function_internal_view$_t_struct$_PolymorphicDictionary_$7490_storage_ptr_$_t_bytes32_$returns$_t_bool_$bound_to$_t_struct$_PolymorphicDictionary_$7490_storage_ptr_$",
												typeString: "function (struct PolymorphicDictionaryLib.PolymorphicDictionary storage pointer,bytes32) view returns (bool)"
											}
										},
										id: 1276,
										isConstant: false,
										isLValue: false,
										isPure: false,
										kind: "functionCall",
										lValueRequested: false,
										names: [
										],
										nodeType: "FunctionCall",
										src: "7950:32:2",
										typeDescriptions: {
											typeIdentifier: "t_bool",
											typeString: "bool"
										}
									},
									nodeType: "BinaryOperation",
									operator: "==",
									rightExpression: {
										argumentTypes: null,
										hexValue: "66616c7365",
										id: 1277,
										isConstant: false,
										isLValue: false,
										isPure: true,
										kind: "bool",
										lValueRequested: false,
										nodeType: "Literal",
										src: "7986:5:2",
										subdenomination: null,
										typeDescriptions: {
											typeIdentifier: "t_bool",
											typeString: "bool"
										},
										value: "false"
									},
									src: "7950:41:2",
									typeDescriptions: {
										typeIdentifier: "t_bool",
										typeString: "bool"
									}
								},
								falseBody: null,
								id: 1286,
								nodeType: "IfStatement",
								src: "7946:109:2",
								trueBody: {
									id: 1285,
									nodeType: "Block",
									src: "7992:63:2",
									statements: [
										{
											expression: {
												argumentTypes: null,
												"arguments": [
													{
														argumentTypes: null,
														id: 1280,
														name: "idTableKey",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 1240,
														src: "8019:10:2",
														typeDescriptions: {
															typeIdentifier: "t_bytes32",
															typeString: "bytes32"
														}
													},
													{
														argumentTypes: null,
														id: 1281,
														name: "id",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 1231,
														src: "8031:2:2",
														typeDescriptions: {
															typeIdentifier: "t_bytes32",
															typeString: "bytes32"
														}
													},
													{
														argumentTypes: null,
														id: 1282,
														name: "tableKey",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 1225,
														src: "8035:8:2",
														typeDescriptions: {
															typeIdentifier: "t_bytes32",
															typeString: "bytes32"
														}
													}
												],
												expression: {
													argumentTypes: [
														{
															typeIdentifier: "t_bytes32",
															typeString: "bytes32"
														},
														{
															typeIdentifier: "t_bytes32",
															typeString: "bytes32"
														},
														{
															typeIdentifier: "t_bytes32",
															typeString: "bytes32"
														}
													],
													id: 1279,
													name: "_setRowOwner",
													nodeType: "Identifier",
													overloadedDeclarations: [
													],
													referencedDeclaration: 1466,
													src: "8006:12:2",
													typeDescriptions: {
														typeIdentifier: "t_function_internal_nonpayable$_t_bytes32_$_t_bytes32_$_t_bytes32_$returns$__$",
														typeString: "function (bytes32,bytes32,bytes32)"
													}
												},
												id: 1283,
												isConstant: false,
												isLValue: false,
												isPure: false,
												kind: "functionCall",
												lValueRequested: false,
												names: [
												],
												nodeType: "FunctionCall",
												src: "8006:38:2",
												typeDescriptions: {
													typeIdentifier: "t_tuple$__$",
													typeString: "tuple()"
												}
											},
											id: 1284,
											nodeType: "ExpressionStatement",
											src: "8006:38:2"
										}
									]
								}
							},
							{
								expression: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1290,
											name: "fieldIdTableKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1247,
											src: "8196:15:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										{
											argumentTypes: null,
											"arguments": [
												{
													argumentTypes: null,
													id: 1292,
													name: "val",
													nodeType: "Identifier",
													overloadedDeclarations: [
													],
													referencedDeclaration: 1233,
													src: "8221:3:2",
													typeDescriptions: {
														typeIdentifier: "t_bytes32",
														typeString: "bytes32"
													}
												}
											],
											expression: {
												argumentTypes: [
													{
														typeIdentifier: "t_bytes32",
														typeString: "bytes32"
													}
												],
												id: 1291,
												isConstant: false,
												isLValue: false,
												isPure: true,
												lValueRequested: false,
												nodeType: "ElementaryTypeNameExpression",
												src: "8213:7:2",
												typeDescriptions: {
													typeIdentifier: "t_type$_t_bytes32_$",
													typeString: "type(bytes32)"
												},
												typeName: "bytes32"
											},
											id: 1293,
											isConstant: false,
											isLValue: false,
											isPure: false,
											kind: "typeConversion",
											lValueRequested: false,
											names: [
											],
											nodeType: "FunctionCall",
											src: "8213:12:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											},
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										],
										expression: {
											argumentTypes: null,
											id: 1287,
											name: "database",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 997,
											src: "8172:8:2",
											typeDescriptions: {
												typeIdentifier: "t_struct$_PolymorphicDictionary_$7490_storage",
												typeString: "struct PolymorphicDictionaryLib.PolymorphicDictionary storage ref"
											}
										},
										id: 1289,
										isConstant: false,
										isLValue: true,
										isPure: false,
										lValueRequested: false,
										memberName: "setValueForKey",
										nodeType: "MemberAccess",
										referencedDeclaration: 8456,
										src: "8172:23:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_nonpayable$_t_struct$_PolymorphicDictionary_$7490_storage_ptr_$_t_bytes32_$_t_bytes32_$returns$_t_bool_$bound_to$_t_struct$_PolymorphicDictionary_$7490_storage_ptr_$",
											typeString: "function (struct PolymorphicDictionaryLib.PolymorphicDictionary storage pointer,bytes32,bytes32) returns (bool)"
										}
									},
									id: 1294,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "8172:54:2",
									typeDescriptions: {
										typeIdentifier: "t_bool",
										typeString: "bool"
									}
								},
								id: 1295,
								nodeType: "ExpressionStatement",
								src: "8172:54:2"
							}
						]
					},
					documentation: "@dev Prior to insert, we check the permissions and autoIncrement\nTODO: use the schema and determine the proper type of data to insert\n     * @param tableKey the namehashed [table] name string\n@param idKey the sha3 hashed idKey\n@param id as the raw string (unhashed)",
					id: 1297,
					implemented: true,
					kind: "function",
					modifiers: [
						{
							"arguments": [
								{
									argumentTypes: null,
									id: 1236,
									name: "tableKey",
									nodeType: "Identifier",
									overloadedDeclarations: [
									],
									referencedDeclaration: 1225,
									src: "7324:8:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								}
							],
							id: 1237,
							modifierName: {
								argumentTypes: null,
								id: 1235,
								name: "insertCheck",
								nodeType: "Identifier",
								overloadedDeclarations: [
								],
								referencedDeclaration: 1223,
								src: "7312:11:2",
								typeDescriptions: {
									typeIdentifier: "t_modifier$_t_bytes32_$",
									typeString: "modifier (bytes32)"
								}
							},
							nodeType: "ModifierInvocation",
							src: "7312:21:2"
						}
					],
					name: "insertVal",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 1234,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1225,
								name: "tableKey",
								nodeType: "VariableDeclaration",
								scope: 1297,
								src: "7191:16:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1224,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "7191:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							},
							{
								constant: false,
								id: 1227,
								name: "idKey",
								nodeType: "VariableDeclaration",
								scope: 1297,
								src: "7217:13:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1226,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "7217:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							},
							{
								constant: false,
								id: 1229,
								name: "fieldKey",
								nodeType: "VariableDeclaration",
								scope: 1297,
								src: "7240:16:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1228,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "7240:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							},
							{
								constant: false,
								id: 1231,
								name: "id",
								nodeType: "VariableDeclaration",
								scope: 1297,
								src: "7267:10:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1230,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "7267:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							},
							{
								constant: false,
								id: 1233,
								name: "val",
								nodeType: "VariableDeclaration",
								scope: 1297,
								src: "7287:11:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1232,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "7287:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "7180:119:2"
					},
					returnParameters: {
						id: 1238,
						nodeType: "ParameterList",
						parameters: [
						],
						src: "7333:0:2"
					},
					scope: 2289,
					src: "7162:1136:2",
					stateMutability: "nonpayable",
					superFunction: null,
					visibility: "public"
				},
				{
					body: {
						id: 1368,
						nodeType: "Block",
						src: "8482:713:2",
						statements: [
							{
								assignments: [
									1314
								],
								declarations: [
									{
										constant: false,
										id: 1314,
										name: "idTableKey",
										nodeType: "VariableDeclaration",
										scope: 1368,
										src: "8493:18:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_bytes32",
											typeString: "bytes32"
										},
										typeName: {
											id: 1313,
											name: "bytes32",
											nodeType: "ElementaryTypeName",
											src: "8493:7:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 1319,
								initialValue: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1316,
											name: "idKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1301,
											src: "8523:5:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										{
											argumentTypes: null,
											id: 1317,
											name: "tableKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1299,
											src: "8530:8:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											},
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										],
										id: 1315,
										name: "namehash",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 1960,
										src: "8514:8:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_pure$_t_bytes32_$_t_bytes32_$returns$_t_bytes32_$",
											typeString: "function (bytes32,bytes32) pure returns (bytes32)"
										}
									},
									id: 1318,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "8514:25:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "8493:46:2"
							},
							{
								assignments: [
									1321
								],
								declarations: [
									{
										constant: false,
										id: 1321,
										name: "fieldIdTableKey",
										nodeType: "VariableDeclaration",
										scope: 1368,
										src: "8549:23:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_bytes32",
											typeString: "bytes32"
										},
										typeName: {
											id: 1320,
											name: "bytes32",
											nodeType: "ElementaryTypeName",
											src: "8549:7:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 1326,
								initialValue: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1323,
											name: "fieldKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1303,
											src: "8584:8:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										{
											argumentTypes: null,
											id: 1324,
											name: "idTableKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1314,
											src: "8594:10:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											},
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										],
										id: 1322,
										name: "namehash",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 1960,
										src: "8575:8:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_pure$_t_bytes32_$_t_bytes32_$returns$_t_bytes32_$",
											typeString: "function (bytes32,bytes32) pure returns (bytes32)"
										}
									},
									id: 1325,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "8575:30:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "8549:56:2"
							},
							{
								expression: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											commonType: {
												typeIdentifier: "t_bool",
												typeString: "bool"
											},
											id: 1333,
											isConstant: false,
											isLValue: false,
											isPure: false,
											lValueRequested: false,
											leftExpression: {
												argumentTypes: null,
												"arguments": [
													{
														argumentTypes: null,
														id: 1330,
														name: "fieldIdTableKey",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 1321,
														src: "8645:15:2",
														typeDescriptions: {
															typeIdentifier: "t_bytes32",
															typeString: "bytes32"
														}
													}
												],
												expression: {
													argumentTypes: [
														{
															typeIdentifier: "t_bytes32",
															typeString: "bytes32"
														}
													],
													expression: {
														argumentTypes: null,
														id: 1328,
														name: "database",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 997,
														src: "8624:8:2",
														typeDescriptions: {
															typeIdentifier: "t_struct$_PolymorphicDictionary_$7490_storage",
															typeString: "struct PolymorphicDictionaryLib.PolymorphicDictionary storage ref"
														}
													},
													id: 1329,
													isConstant: false,
													isLValue: true,
													isPure: false,
													lValueRequested: false,
													memberName: "containsKey",
													nodeType: "MemberAccess",
													referencedDeclaration: 7798,
													src: "8624:20:2",
													typeDescriptions: {
														typeIdentifier: "t_function_internal_view$_t_struct$_PolymorphicDictionary_$7490_storage_ptr_$_t_bytes32_$returns$_t_bool_$bound_to$_t_struct$_PolymorphicDictionary_$7490_storage_ptr_$",
														typeString: "function (struct PolymorphicDictionaryLib.PolymorphicDictionary storage pointer,bytes32) view returns (bool)"
													}
												},
												id: 1331,
												isConstant: false,
												isLValue: false,
												isPure: false,
												kind: "functionCall",
												lValueRequested: false,
												names: [
												],
												nodeType: "FunctionCall",
												src: "8624:37:2",
												typeDescriptions: {
													typeIdentifier: "t_bool",
													typeString: "bool"
												}
											},
											nodeType: "BinaryOperation",
											operator: "==",
											rightExpression: {
												argumentTypes: null,
												hexValue: "66616c7365",
												id: 1332,
												isConstant: false,
												isLValue: false,
												isPure: true,
												kind: "bool",
												lValueRequested: false,
												nodeType: "Literal",
												src: "8665:5:2",
												subdenomination: null,
												typeDescriptions: {
													typeIdentifier: "t_bool",
													typeString: "bool"
												},
												value: "false"
											},
											src: "8624:46:2",
											typeDescriptions: {
												typeIdentifier: "t_bool",
												typeString: "bool"
											}
										},
										{
											argumentTypes: null,
											hexValue: "69642b6669656c6420616c726561647920657869737473",
											id: 1334,
											isConstant: false,
											isLValue: false,
											isPure: true,
											kind: "string",
											lValueRequested: false,
											nodeType: "Literal",
											src: "8672:25:2",
											subdenomination: null,
											typeDescriptions: {
												typeIdentifier: "t_stringliteral_b47ab3ca8e2817377098c0fdb9f676216babd1393ec4fa6b120ecb6719d9fd66",
												typeString: "literal_string \"id+field already exists\""
											},
											value: "id+field already exists"
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bool",
												typeString: "bool"
											},
											{
												typeIdentifier: "t_stringliteral_b47ab3ca8e2817377098c0fdb9f676216babd1393ec4fa6b120ecb6719d9fd66",
												typeString: "literal_string \"id+field already exists\""
											}
										],
										id: 1327,
										name: "require",
										nodeType: "Identifier",
										overloadedDeclarations: [
											11011,
											11012
										],
										referencedDeclaration: 11012,
										src: "8616:7:2",
										typeDescriptions: {
											typeIdentifier: "t_function_require_pure$_t_bool_$_t_string_memory_ptr_$returns$__$",
											typeString: "function (bool,string memory) pure"
										}
									},
									id: 1335,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "8616:82:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 1336,
								nodeType: "ExpressionStatement",
								src: "8616:82:2"
							},
							{
								expression: {
									argumentTypes: null,
									"arguments": [
									],
									expression: {
										argumentTypes: [
										],
										id: 1337,
										name: "increaseGsnCounter",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 2128,
										src: "8738:18:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_nonpayable$__$returns$__$",
											typeString: "function ()"
										}
									},
									id: 1338,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "8738:20:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 1339,
								nodeType: "ExpressionStatement",
								src: "8738:20:2"
							},
							{
								expression: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1343,
											name: "tableKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1299,
											src: "8857:8:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										{
											argumentTypes: null,
											id: 1344,
											name: "id",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1305,
											src: "8867:2:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											},
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										],
										expression: {
											argumentTypes: null,
											id: 1340,
											name: "tableId",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 986,
											src: "8834:7:2",
											typeDescriptions: {
												typeIdentifier: "t_struct$_Bytes32SetDictionary_$6250_storage",
												typeString: "struct Bytes32SetDictionaryLib.Bytes32SetDictionary storage ref"
											}
										},
										id: 1342,
										isConstant: false,
										isLValue: true,
										isPure: false,
										lValueRequested: false,
										memberName: "addValueForKey",
										nodeType: "MemberAccess",
										referencedDeclaration: 6354,
										src: "8834:22:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_nonpayable$_t_struct$_Bytes32SetDictionary_$6250_storage_ptr_$_t_bytes32_$_t_bytes32_$returns$_t_bool_$bound_to$_t_struct$_Bytes32SetDictionary_$6250_storage_ptr_$",
											typeString: "function (struct Bytes32SetDictionaryLib.Bytes32SetDictionary storage pointer,bytes32,bytes32) returns (bool)"
										}
									},
									id: 1345,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "8834:36:2",
									typeDescriptions: {
										typeIdentifier: "t_bool",
										typeString: "bool"
									}
								},
								id: 1346,
								nodeType: "ExpressionStatement",
								src: "8834:36:2"
							},
							{
								condition: {
									argumentTypes: null,
									commonType: {
										typeIdentifier: "t_bool",
										typeString: "bool"
									},
									id: 1352,
									isConstant: false,
									isLValue: false,
									isPure: false,
									lValueRequested: false,
									leftExpression: {
										argumentTypes: null,
										"arguments": [
											{
												argumentTypes: null,
												id: 1349,
												name: "idTableKey",
												nodeType: "Identifier",
												overloadedDeclarations: [
												],
												referencedDeclaration: 1314,
												src: "9017:10:2",
												typeDescriptions: {
													typeIdentifier: "t_bytes32",
													typeString: "bytes32"
												}
											}
										],
										expression: {
											argumentTypes: [
												{
													typeIdentifier: "t_bytes32",
													typeString: "bytes32"
												}
											],
											expression: {
												argumentTypes: null,
												id: 1347,
												name: "database",
												nodeType: "Identifier",
												overloadedDeclarations: [
												],
												referencedDeclaration: 997,
												src: "8996:8:2",
												typeDescriptions: {
													typeIdentifier: "t_struct$_PolymorphicDictionary_$7490_storage",
													typeString: "struct PolymorphicDictionaryLib.PolymorphicDictionary storage ref"
												}
											},
											id: 1348,
											isConstant: false,
											isLValue: true,
											isPure: false,
											lValueRequested: false,
											memberName: "containsKey",
											nodeType: "MemberAccess",
											referencedDeclaration: 7798,
											src: "8996:20:2",
											typeDescriptions: {
												typeIdentifier: "t_function_internal_view$_t_struct$_PolymorphicDictionary_$7490_storage_ptr_$_t_bytes32_$returns$_t_bool_$bound_to$_t_struct$_PolymorphicDictionary_$7490_storage_ptr_$",
												typeString: "function (struct PolymorphicDictionaryLib.PolymorphicDictionary storage pointer,bytes32) view returns (bool)"
											}
										},
										id: 1350,
										isConstant: false,
										isLValue: false,
										isPure: false,
										kind: "functionCall",
										lValueRequested: false,
										names: [
										],
										nodeType: "FunctionCall",
										src: "8996:32:2",
										typeDescriptions: {
											typeIdentifier: "t_bool",
											typeString: "bool"
										}
									},
									nodeType: "BinaryOperation",
									operator: "==",
									rightExpression: {
										argumentTypes: null,
										hexValue: "66616c7365",
										id: 1351,
										isConstant: false,
										isLValue: false,
										isPure: true,
										kind: "bool",
										lValueRequested: false,
										nodeType: "Literal",
										src: "9032:5:2",
										subdenomination: null,
										typeDescriptions: {
											typeIdentifier: "t_bool",
											typeString: "bool"
										},
										value: "false"
									},
									src: "8996:41:2",
									typeDescriptions: {
										typeIdentifier: "t_bool",
										typeString: "bool"
									}
								},
								falseBody: null,
								id: 1360,
								nodeType: "IfStatement",
								src: "8992:109:2",
								trueBody: {
									id: 1359,
									nodeType: "Block",
									src: "9038:63:2",
									statements: [
										{
											expression: {
												argumentTypes: null,
												"arguments": [
													{
														argumentTypes: null,
														id: 1354,
														name: "idTableKey",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 1314,
														src: "9065:10:2",
														typeDescriptions: {
															typeIdentifier: "t_bytes32",
															typeString: "bytes32"
														}
													},
													{
														argumentTypes: null,
														id: 1355,
														name: "id",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 1305,
														src: "9077:2:2",
														typeDescriptions: {
															typeIdentifier: "t_bytes32",
															typeString: "bytes32"
														}
													},
													{
														argumentTypes: null,
														id: 1356,
														name: "tableKey",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 1299,
														src: "9081:8:2",
														typeDescriptions: {
															typeIdentifier: "t_bytes32",
															typeString: "bytes32"
														}
													}
												],
												expression: {
													argumentTypes: [
														{
															typeIdentifier: "t_bytes32",
															typeString: "bytes32"
														},
														{
															typeIdentifier: "t_bytes32",
															typeString: "bytes32"
														},
														{
															typeIdentifier: "t_bytes32",
															typeString: "bytes32"
														}
													],
													id: 1353,
													name: "_setRowOwner",
													nodeType: "Identifier",
													overloadedDeclarations: [
													],
													referencedDeclaration: 1466,
													src: "9052:12:2",
													typeDescriptions: {
														typeIdentifier: "t_function_internal_nonpayable$_t_bytes32_$_t_bytes32_$_t_bytes32_$returns$__$",
														typeString: "function (bytes32,bytes32,bytes32)"
													}
												},
												id: 1357,
												isConstant: false,
												isLValue: false,
												isPure: false,
												kind: "functionCall",
												lValueRequested: false,
												names: [
												],
												nodeType: "FunctionCall",
												src: "9052:38:2",
												typeDescriptions: {
													typeIdentifier: "t_tuple$__$",
													typeString: "tuple()"
												}
											},
											id: 1358,
											nodeType: "ExpressionStatement",
											src: "9052:38:2"
										}
									]
								}
							},
							{
								expression: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1364,
											name: "fieldIdTableKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1321,
											src: "9167:15:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										{
											argumentTypes: null,
											id: 1365,
											name: "val",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1307,
											src: "9184:3:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes_memory_ptr",
												typeString: "bytes memory"
											}
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											},
											{
												typeIdentifier: "t_bytes_memory_ptr",
												typeString: "bytes memory"
											}
										],
										expression: {
											argumentTypes: null,
											id: 1361,
											name: "database",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 997,
											src: "9143:8:2",
											typeDescriptions: {
												typeIdentifier: "t_struct$_PolymorphicDictionary_$7490_storage",
												typeString: "struct PolymorphicDictionaryLib.PolymorphicDictionary storage ref"
											}
										},
										id: 1363,
										isConstant: false,
										isLValue: true,
										isPure: false,
										lValueRequested: false,
										memberName: "setValueForKey",
										nodeType: "MemberAccess",
										referencedDeclaration: 8603,
										src: "9143:23:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_nonpayable$_t_struct$_PolymorphicDictionary_$7490_storage_ptr_$_t_bytes32_$_t_bytes_memory_ptr_$returns$_t_bool_$bound_to$_t_struct$_PolymorphicDictionary_$7490_storage_ptr_$",
											typeString: "function (struct PolymorphicDictionaryLib.PolymorphicDictionary storage pointer,bytes32,bytes memory) returns (bool)"
										}
									},
									id: 1366,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "9143:45:2",
									typeDescriptions: {
										typeIdentifier: "t_bool",
										typeString: "bool"
									}
								},
								id: 1367,
								nodeType: "ExpressionStatement",
								src: "9143:45:2"
							}
						]
					},
					documentation: null,
					id: 1369,
					implemented: true,
					kind: "function",
					modifiers: [
						{
							"arguments": [
								{
									argumentTypes: null,
									id: 1310,
									name: "tableKey",
									nodeType: "Identifier",
									overloadedDeclarations: [
									],
									referencedDeclaration: 1299,
									src: "8473:8:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								}
							],
							id: 1311,
							modifierName: {
								argumentTypes: null,
								id: 1309,
								name: "insertCheck",
								nodeType: "Identifier",
								overloadedDeclarations: [
								],
								referencedDeclaration: 1223,
								src: "8461:11:2",
								typeDescriptions: {
									typeIdentifier: "t_modifier$_t_bytes32_$",
									typeString: "modifier (bytes32)"
								}
							},
							nodeType: "ModifierInvocation",
							src: "8461:21:2"
						}
					],
					name: "insertValVar",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 1308,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1299,
								name: "tableKey",
								nodeType: "VariableDeclaration",
								scope: 1369,
								src: "8335:16:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1298,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "8335:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							},
							{
								constant: false,
								id: 1301,
								name: "idKey",
								nodeType: "VariableDeclaration",
								scope: 1369,
								src: "8361:13:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1300,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "8361:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							},
							{
								constant: false,
								id: 1303,
								name: "fieldKey",
								nodeType: "VariableDeclaration",
								scope: 1369,
								src: "8384:16:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1302,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "8384:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							},
							{
								constant: false,
								id: 1305,
								name: "id",
								nodeType: "VariableDeclaration",
								scope: 1369,
								src: "8411:10:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1304,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "8411:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							},
							{
								constant: false,
								id: 1307,
								name: "val",
								nodeType: "VariableDeclaration",
								scope: 1369,
								src: "8431:16:2",
								stateVariable: false,
								storageLocation: "memory",
								typeDescriptions: {
									typeIdentifier: "t_bytes_memory_ptr",
									typeString: "bytes"
								},
								typeName: {
									id: 1306,
									name: "bytes",
									nodeType: "ElementaryTypeName",
									src: "8431:5:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes_storage_ptr",
										typeString: "bytes"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "8325:123:2"
					},
					returnParameters: {
						id: 1312,
						nodeType: "ParameterList",
						parameters: [
						],
						src: "8482:0:2"
					},
					scope: 2289,
					src: "8304:891:2",
					stateMutability: "nonpayable",
					superFunction: null,
					visibility: "public"
				},
				{
					body: {
						id: 1465,
						nodeType: "Block",
						src: "9407:602:2",
						statements: [
							{
								expression: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											commonType: {
												typeIdentifier: "t_bool",
												typeString: "bool"
											},
											id: 1384,
											isConstant: false,
											isLValue: false,
											isPure: false,
											lValueRequested: false,
											leftExpression: {
												argumentTypes: null,
												"arguments": [
													{
														argumentTypes: null,
														id: 1381,
														name: "idTableKey",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 1371,
														src: "9447:10:2",
														typeDescriptions: {
															typeIdentifier: "t_bytes32",
															typeString: "bytes32"
														}
													}
												],
												expression: {
													argumentTypes: [
														{
															typeIdentifier: "t_bytes32",
															typeString: "bytes32"
														}
													],
													expression: {
														argumentTypes: null,
														id: 1379,
														name: "database",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 997,
														src: "9426:8:2",
														typeDescriptions: {
															typeIdentifier: "t_struct$_PolymorphicDictionary_$7490_storage",
															typeString: "struct PolymorphicDictionaryLib.PolymorphicDictionary storage ref"
														}
													},
													id: 1380,
													isConstant: false,
													isLValue: true,
													isPure: false,
													lValueRequested: false,
													memberName: "containsKey",
													nodeType: "MemberAccess",
													referencedDeclaration: 7798,
													src: "9426:20:2",
													typeDescriptions: {
														typeIdentifier: "t_function_internal_view$_t_struct$_PolymorphicDictionary_$7490_storage_ptr_$_t_bytes32_$returns$_t_bool_$bound_to$_t_struct$_PolymorphicDictionary_$7490_storage_ptr_$",
														typeString: "function (struct PolymorphicDictionaryLib.PolymorphicDictionary storage pointer,bytes32) view returns (bool)"
													}
												},
												id: 1382,
												isConstant: false,
												isLValue: false,
												isPure: false,
												kind: "functionCall",
												lValueRequested: false,
												names: [
												],
												nodeType: "FunctionCall",
												src: "9426:32:2",
												typeDescriptions: {
													typeIdentifier: "t_bool",
													typeString: "bool"
												}
											},
											nodeType: "BinaryOperation",
											operator: "==",
											rightExpression: {
												argumentTypes: null,
												hexValue: "66616c7365",
												id: 1383,
												isConstant: false,
												isLValue: false,
												isPure: true,
												kind: "bool",
												lValueRequested: false,
												nodeType: "Literal",
												src: "9462:5:2",
												subdenomination: null,
												typeDescriptions: {
													typeIdentifier: "t_bool",
													typeString: "bool"
												},
												value: "false"
											},
											src: "9426:41:2",
											typeDescriptions: {
												typeIdentifier: "t_bool",
												typeString: "bool"
											}
										},
										{
											argumentTypes: null,
											hexValue: "726f7720616c726561647920686173206f776e6572",
											id: 1385,
											isConstant: false,
											isLValue: false,
											isPure: true,
											kind: "string",
											lValueRequested: false,
											nodeType: "Literal",
											src: "9469:23:2",
											subdenomination: null,
											typeDescriptions: {
												typeIdentifier: "t_stringliteral_4f07436c5e922fe8ea527b1a1ba7481aa8d495ad72c7a326d88e3d9b4d6a1f59",
												typeString: "literal_string \"row already has owner\""
											},
											value: "row already has owner"
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bool",
												typeString: "bool"
											},
											{
												typeIdentifier: "t_stringliteral_4f07436c5e922fe8ea527b1a1ba7481aa8d495ad72c7a326d88e3d9b4d6a1f59",
												typeString: "literal_string \"row already has owner\""
											}
										],
										id: 1378,
										name: "require",
										nodeType: "Identifier",
										overloadedDeclarations: [
											11011,
											11012
										],
										referencedDeclaration: 11012,
										src: "9418:7:2",
										typeDescriptions: {
											typeIdentifier: "t_function_require_pure$_t_bool_$_t_string_memory_ptr_$returns$__$",
											typeString: "function (bool,string memory) pure"
										}
									},
									id: 1386,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "9418:75:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 1387,
								nodeType: "ExpressionStatement",
								src: "9418:75:2"
							},
							{
								assignments: [
									1389
								],
								declarations: [
									{
										constant: false,
										id: 1389,
										name: "rowMetadata",
										nodeType: "VariableDeclaration",
										scope: 1465,
										src: "9504:19:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										},
										typeName: {
											id: 1388,
											name: "uint256",
											nodeType: "ElementaryTypeName",
											src: "9504:7:2",
											typeDescriptions: {
												typeIdentifier: "t_uint256",
												typeString: "uint256"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 1390,
								initialValue: null,
								nodeType: "VariableDeclarationStatement",
								src: "9504:19:2"
							},
							{
								assignments: [
									1392
								],
								declarations: [
									{
										constant: false,
										id: 1392,
										name: "year",
										nodeType: "VariableDeclaration",
										scope: 1465,
										src: "9534:11:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_uint16",
											typeString: "uint16"
										},
										typeName: {
											id: 1391,
											name: "uint16",
											nodeType: "ElementaryTypeName",
											src: "9534:6:2",
											typeDescriptions: {
												typeIdentifier: "t_uint16",
												typeString: "uint16"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 1397,
								initialValue: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1395,
											name: "now",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 11010,
											src: "9565:3:2",
											typeDescriptions: {
												typeIdentifier: "t_uint256",
												typeString: "uint256"
											}
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_uint256",
												typeString: "uint256"
											}
										],
										expression: {
											argumentTypes: null,
											id: 1393,
											name: "dateTime",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 968,
											src: "9548:8:2",
											typeDescriptions: {
												typeIdentifier: "t_contract$_DateTime_$956",
												typeString: "contract DateTime"
											}
										},
										id: 1394,
										isConstant: false,
										isLValue: false,
										isPure: false,
										lValueRequested: false,
										memberName: "getYear",
										nodeType: "MemberAccess",
										referencedDeclaration: 941,
										src: "9548:16:2",
										typeDescriptions: {
											typeIdentifier: "t_function_external_pure$_t_uint256_$returns$_t_uint16_$",
											typeString: "function (uint256) pure external returns (uint16)"
										}
									},
									id: 1396,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "9548:21:2",
									typeDescriptions: {
										typeIdentifier: "t_uint16",
										typeString: "uint16"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "9534:35:2"
							},
							{
								assignments: [
									1399
								],
								declarations: [
									{
										constant: false,
										id: 1399,
										name: "month",
										nodeType: "VariableDeclaration",
										scope: 1465,
										src: "9579:11:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_uint8",
											typeString: "uint8"
										},
										typeName: {
											id: 1398,
											name: "uint8",
											nodeType: "ElementaryTypeName",
											src: "9579:5:2",
											typeDescriptions: {
												typeIdentifier: "t_uint8",
												typeString: "uint8"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 1404,
								initialValue: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1402,
											name: "now",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 11010,
											src: "9611:3:2",
											typeDescriptions: {
												typeIdentifier: "t_uint256",
												typeString: "uint256"
											}
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_uint256",
												typeString: "uint256"
											}
										],
										expression: {
											argumentTypes: null,
											id: 1400,
											name: "dateTime",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 968,
											src: "9593:8:2",
											typeDescriptions: {
												typeIdentifier: "t_contract$_DateTime_$956",
												typeString: "contract DateTime"
											}
										},
										id: 1401,
										isConstant: false,
										isLValue: false,
										isPure: false,
										lValueRequested: false,
										memberName: "getMonth",
										nodeType: "MemberAccess",
										referencedDeclaration: 948,
										src: "9593:17:2",
										typeDescriptions: {
											typeIdentifier: "t_function_external_pure$_t_uint256_$returns$_t_uint8_$",
											typeString: "function (uint256) pure external returns (uint8)"
										}
									},
									id: 1403,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "9593:22:2",
									typeDescriptions: {
										typeIdentifier: "t_uint8",
										typeString: "uint8"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "9579:36:2"
							},
							{
								assignments: [
									1406
								],
								declarations: [
									{
										constant: false,
										id: 1406,
										name: "day",
										nodeType: "VariableDeclaration",
										scope: 1465,
										src: "9625:9:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_uint8",
											typeString: "uint8"
										},
										typeName: {
											id: 1405,
											name: "uint8",
											nodeType: "ElementaryTypeName",
											src: "9625:5:2",
											typeDescriptions: {
												typeIdentifier: "t_uint8",
												typeString: "uint8"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 1411,
								initialValue: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1409,
											name: "now",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 11010,
											src: "9653:3:2",
											typeDescriptions: {
												typeIdentifier: "t_uint256",
												typeString: "uint256"
											}
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_uint256",
												typeString: "uint256"
											}
										],
										expression: {
											argumentTypes: null,
											id: 1407,
											name: "dateTime",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 968,
											src: "9637:8:2",
											typeDescriptions: {
												typeIdentifier: "t_contract$_DateTime_$956",
												typeString: "contract DateTime"
											}
										},
										id: 1408,
										isConstant: false,
										isLValue: false,
										isPure: false,
										lValueRequested: false,
										memberName: "getDay",
										nodeType: "MemberAccess",
										referencedDeclaration: 955,
										src: "9637:15:2",
										typeDescriptions: {
											typeIdentifier: "t_function_external_pure$_t_uint256_$returns$_t_uint8_$",
											typeString: "function (uint256) pure external returns (uint8)"
										}
									},
									id: 1410,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "9637:20:2",
									typeDescriptions: {
										typeIdentifier: "t_uint8",
										typeString: "uint8"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "9625:32:2"
							},
							{
								expression: {
									argumentTypes: null,
									id: 1414,
									isConstant: false,
									isLValue: false,
									isPure: false,
									lValueRequested: false,
									leftHandSide: {
										argumentTypes: null,
										id: 1412,
										name: "rowMetadata",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 1389,
										src: "9668:11:2",
										typeDescriptions: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										}
									},
									nodeType: "Assignment",
									operator: "|=",
									rightHandSide: {
										argumentTypes: null,
										id: 1413,
										name: "year",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 1392,
										src: "9683:4:2",
										typeDescriptions: {
											typeIdentifier: "t_uint16",
											typeString: "uint16"
										}
									},
									src: "9668:19:2",
									typeDescriptions: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									}
								},
								id: 1415,
								nodeType: "ExpressionStatement",
								src: "9668:19:2"
							},
							{
								expression: {
									argumentTypes: null,
									id: 1422,
									isConstant: false,
									isLValue: false,
									isPure: false,
									lValueRequested: false,
									leftHandSide: {
										argumentTypes: null,
										id: 1416,
										name: "rowMetadata",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 1389,
										src: "9697:11:2",
										typeDescriptions: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										}
									},
									nodeType: "Assignment",
									operator: "|=",
									rightHandSide: {
										argumentTypes: null,
										commonType: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										},
										id: 1421,
										isConstant: false,
										isLValue: false,
										isPure: false,
										lValueRequested: false,
										leftExpression: {
											argumentTypes: null,
											"arguments": [
												{
													argumentTypes: null,
													id: 1418,
													name: "month",
													nodeType: "Identifier",
													overloadedDeclarations: [
													],
													referencedDeclaration: 1399,
													src: "9720:5:2",
													typeDescriptions: {
														typeIdentifier: "t_uint8",
														typeString: "uint8"
													}
												}
											],
											expression: {
												argumentTypes: [
													{
														typeIdentifier: "t_uint8",
														typeString: "uint8"
													}
												],
												id: 1417,
												isConstant: false,
												isLValue: false,
												isPure: true,
												lValueRequested: false,
												nodeType: "ElementaryTypeNameExpression",
												src: "9712:7:2",
												typeDescriptions: {
													typeIdentifier: "t_type$_t_uint256_$",
													typeString: "type(uint256)"
												},
												typeName: "uint256"
											},
											id: 1419,
											isConstant: false,
											isLValue: false,
											isPure: false,
											kind: "typeConversion",
											lValueRequested: false,
											names: [
											],
											nodeType: "FunctionCall",
											src: "9712:14:2",
											typeDescriptions: {
												typeIdentifier: "t_uint256",
												typeString: "uint256"
											}
										},
										nodeType: "BinaryOperation",
										operator: "<<",
										rightExpression: {
											argumentTypes: null,
											hexValue: "3136",
											id: 1420,
											isConstant: false,
											isLValue: false,
											isPure: true,
											kind: "number",
											lValueRequested: false,
											nodeType: "Literal",
											src: "9728:2:2",
											subdenomination: null,
											typeDescriptions: {
												typeIdentifier: "t_rational_16_by_1",
												typeString: "int_const 16"
											},
											value: "16"
										},
										src: "9712:18:2",
										typeDescriptions: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										}
									},
									src: "9697:33:2",
									typeDescriptions: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									}
								},
								id: 1423,
								nodeType: "ExpressionStatement",
								src: "9697:33:2"
							},
							{
								expression: {
									argumentTypes: null,
									id: 1430,
									isConstant: false,
									isLValue: false,
									isPure: false,
									lValueRequested: false,
									leftHandSide: {
										argumentTypes: null,
										id: 1424,
										name: "rowMetadata",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 1389,
										src: "9740:11:2",
										typeDescriptions: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										}
									},
									nodeType: "Assignment",
									operator: "|=",
									rightHandSide: {
										argumentTypes: null,
										commonType: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										},
										id: 1429,
										isConstant: false,
										isLValue: false,
										isPure: false,
										lValueRequested: false,
										leftExpression: {
											argumentTypes: null,
											"arguments": [
												{
													argumentTypes: null,
													id: 1426,
													name: "day",
													nodeType: "Identifier",
													overloadedDeclarations: [
													],
													referencedDeclaration: 1406,
													src: "9763:3:2",
													typeDescriptions: {
														typeIdentifier: "t_uint8",
														typeString: "uint8"
													}
												}
											],
											expression: {
												argumentTypes: [
													{
														typeIdentifier: "t_uint8",
														typeString: "uint8"
													}
												],
												id: 1425,
												isConstant: false,
												isLValue: false,
												isPure: true,
												lValueRequested: false,
												nodeType: "ElementaryTypeNameExpression",
												src: "9755:7:2",
												typeDescriptions: {
													typeIdentifier: "t_type$_t_uint256_$",
													typeString: "type(uint256)"
												},
												typeName: "uint256"
											},
											id: 1427,
											isConstant: false,
											isLValue: false,
											isPure: false,
											kind: "typeConversion",
											lValueRequested: false,
											names: [
											],
											nodeType: "FunctionCall",
											src: "9755:12:2",
											typeDescriptions: {
												typeIdentifier: "t_uint256",
												typeString: "uint256"
											}
										},
										nodeType: "BinaryOperation",
										operator: "<<",
										rightExpression: {
											argumentTypes: null,
											hexValue: "3234",
											id: 1428,
											isConstant: false,
											isLValue: false,
											isPure: true,
											kind: "number",
											lValueRequested: false,
											nodeType: "Literal",
											src: "9769:2:2",
											subdenomination: null,
											typeDescriptions: {
												typeIdentifier: "t_rational_24_by_1",
												typeString: "int_const 24"
											},
											value: "24"
										},
										src: "9755:16:2",
										typeDescriptions: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										}
									},
									src: "9740:31:2",
									typeDescriptions: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									}
								},
								id: 1431,
								nodeType: "ExpressionStatement",
								src: "9740:31:2"
							},
							{
								assignments: [
									1433
								],
								declarations: [
									{
										constant: false,
										id: 1433,
										name: "createdDate",
										nodeType: "VariableDeclaration",
										scope: 1465,
										src: "9782:18:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_bytes4",
											typeString: "bytes4"
										},
										typeName: {
											id: 1432,
											name: "bytes4",
											nodeType: "ElementaryTypeName",
											src: "9782:6:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes4",
												typeString: "bytes4"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 1439,
								initialValue: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											"arguments": [
												{
													argumentTypes: null,
													id: 1436,
													name: "rowMetadata",
													nodeType: "Identifier",
													overloadedDeclarations: [
													],
													referencedDeclaration: 1389,
													src: "9817:11:2",
													typeDescriptions: {
														typeIdentifier: "t_uint256",
														typeString: "uint256"
													}
												}
											],
											expression: {
												argumentTypes: [
													{
														typeIdentifier: "t_uint256",
														typeString: "uint256"
													}
												],
												id: 1435,
												isConstant: false,
												isLValue: false,
												isPure: true,
												lValueRequested: false,
												nodeType: "ElementaryTypeNameExpression",
												src: "9810:6:2",
												typeDescriptions: {
													typeIdentifier: "t_type$_t_uint32_$",
													typeString: "type(uint32)"
												},
												typeName: "uint32"
											},
											id: 1437,
											isConstant: false,
											isLValue: false,
											isPure: false,
											kind: "typeConversion",
											lValueRequested: false,
											names: [
											],
											nodeType: "FunctionCall",
											src: "9810:19:2",
											typeDescriptions: {
												typeIdentifier: "t_uint32",
												typeString: "uint32"
											}
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_uint32",
												typeString: "uint32"
											}
										],
										id: 1434,
										isConstant: false,
										isLValue: false,
										isPure: true,
										lValueRequested: false,
										nodeType: "ElementaryTypeNameExpression",
										src: "9803:6:2",
										typeDescriptions: {
											typeIdentifier: "t_type$_t_bytes4_$",
											typeString: "type(bytes4)"
										},
										typeName: "bytes4"
									},
									id: 1438,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "typeConversion",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "9803:27:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes4",
										typeString: "bytes4"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "9782:48:2"
							},
							{
								expression: {
									argumentTypes: null,
									id: 1447,
									isConstant: false,
									isLValue: false,
									isPure: false,
									lValueRequested: false,
									leftHandSide: {
										argumentTypes: null,
										id: 1440,
										name: "rowMetadata",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 1389,
										src: "9841:11:2",
										typeDescriptions: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										}
									},
									nodeType: "Assignment",
									operator: "|=",
									rightHandSide: {
										argumentTypes: null,
										commonType: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										},
										id: 1446,
										isConstant: false,
										isLValue: false,
										isPure: false,
										lValueRequested: false,
										leftExpression: {
											argumentTypes: null,
											"arguments": [
												{
													argumentTypes: null,
													"arguments": [
													],
													expression: {
														argumentTypes: [
														],
														id: 1442,
														name: "_msgSender",
														nodeType: "Identifier",
														overloadedDeclarations: [
															3607
														],
														referencedDeclaration: 3607,
														src: "9864:10:2",
														typeDescriptions: {
															typeIdentifier: "t_function_internal_view$__$returns$_t_address_$",
															typeString: "function () view returns (address)"
														}
													},
													id: 1443,
													isConstant: false,
													isLValue: false,
													isPure: false,
													kind: "functionCall",
													lValueRequested: false,
													names: [
													],
													nodeType: "FunctionCall",
													src: "9864:12:2",
													typeDescriptions: {
														typeIdentifier: "t_address",
														typeString: "address"
													}
												}
											],
											expression: {
												argumentTypes: [
													{
														typeIdentifier: "t_address",
														typeString: "address"
													}
												],
												id: 1441,
												isConstant: false,
												isLValue: false,
												isPure: true,
												lValueRequested: false,
												nodeType: "ElementaryTypeNameExpression",
												src: "9856:7:2",
												typeDescriptions: {
													typeIdentifier: "t_type$_t_uint256_$",
													typeString: "type(uint256)"
												},
												typeName: "uint256"
											},
											id: 1444,
											isConstant: false,
											isLValue: false,
											isPure: false,
											kind: "typeConversion",
											lValueRequested: false,
											names: [
											],
											nodeType: "FunctionCall",
											src: "9856:21:2",
											typeDescriptions: {
												typeIdentifier: "t_uint256",
												typeString: "uint256"
											}
										},
										nodeType: "BinaryOperation",
										operator: "<<",
										rightExpression: {
											argumentTypes: null,
											hexValue: "3332",
											id: 1445,
											isConstant: false,
											isLValue: false,
											isPure: true,
											kind: "number",
											lValueRequested: false,
											nodeType: "Literal",
											src: "9879:2:2",
											subdenomination: null,
											typeDescriptions: {
												typeIdentifier: "t_rational_32_by_1",
												typeString: "int_const 32"
											},
											value: "32"
										},
										src: "9856:25:2",
										typeDescriptions: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										}
									},
									src: "9841:40:2",
									typeDescriptions: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									}
								},
								id: 1448,
								nodeType: "ExpressionStatement",
								src: "9841:40:2"
							},
							{
								expression: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1452,
											name: "idTableKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1371,
											src: "9916:10:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										{
											argumentTypes: null,
											"arguments": [
												{
													argumentTypes: null,
													id: 1454,
													name: "rowMetadata",
													nodeType: "Identifier",
													overloadedDeclarations: [
													],
													referencedDeclaration: 1389,
													src: "9936:11:2",
													typeDescriptions: {
														typeIdentifier: "t_uint256",
														typeString: "uint256"
													}
												}
											],
											expression: {
												argumentTypes: [
													{
														typeIdentifier: "t_uint256",
														typeString: "uint256"
													}
												],
												id: 1453,
												isConstant: false,
												isLValue: false,
												isPure: true,
												lValueRequested: false,
												nodeType: "ElementaryTypeNameExpression",
												src: "9928:7:2",
												typeDescriptions: {
													typeIdentifier: "t_type$_t_bytes32_$",
													typeString: "type(bytes32)"
												},
												typeName: "bytes32"
											},
											id: 1455,
											isConstant: false,
											isLValue: false,
											isPure: false,
											kind: "typeConversion",
											lValueRequested: false,
											names: [
											],
											nodeType: "FunctionCall",
											src: "9928:20:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											},
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										],
										expression: {
											argumentTypes: null,
											id: 1449,
											name: "database",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 997,
											src: "9892:8:2",
											typeDescriptions: {
												typeIdentifier: "t_struct$_PolymorphicDictionary_$7490_storage",
												typeString: "struct PolymorphicDictionaryLib.PolymorphicDictionary storage ref"
											}
										},
										id: 1451,
										isConstant: false,
										isLValue: true,
										isPure: false,
										lValueRequested: false,
										memberName: "setValueForKey",
										nodeType: "MemberAccess",
										referencedDeclaration: 8456,
										src: "9892:23:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_nonpayable$_t_struct$_PolymorphicDictionary_$7490_storage_ptr_$_t_bytes32_$_t_bytes32_$returns$_t_bool_$bound_to$_t_struct$_PolymorphicDictionary_$7490_storage_ptr_$",
											typeString: "function (struct PolymorphicDictionaryLib.PolymorphicDictionary storage pointer,bytes32,bytes32) returns (bool)"
										}
									},
									id: 1456,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "9892:57:2",
									typeDescriptions: {
										typeIdentifier: "t_bool",
										typeString: "bool"
									}
								},
								id: 1457,
								nodeType: "ExpressionStatement",
								src: "9892:57:2"
							},
							{
								eventCall: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1459,
											name: "id",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1373,
											src: "9975:2:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										{
											argumentTypes: null,
											id: 1460,
											name: "tableKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1375,
											src: "9979:8:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										{
											argumentTypes: null,
											"arguments": [
											],
											expression: {
												argumentTypes: [
												],
												id: 1461,
												name: "_msgSender",
												nodeType: "Identifier",
												overloadedDeclarations: [
													3607
												],
												referencedDeclaration: 3607,
												src: "9989:10:2",
												typeDescriptions: {
													typeIdentifier: "t_function_internal_view$__$returns$_t_address_$",
													typeString: "function () view returns (address)"
												}
											},
											id: 1462,
											isConstant: false,
											isLValue: false,
											isPure: false,
											kind: "functionCall",
											lValueRequested: false,
											names: [
											],
											nodeType: "FunctionCall",
											src: "9989:12:2",
											typeDescriptions: {
												typeIdentifier: "t_address",
												typeString: "address"
											}
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											},
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											},
											{
												typeIdentifier: "t_address",
												typeString: "address"
											}
										],
										id: 1458,
										name: "InsertRow",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 1474,
										src: "9965:9:2",
										typeDescriptions: {
											typeIdentifier: "t_function_event_nonpayable$_t_bytes32_$_t_bytes32_$_t_address_$returns$__$",
											typeString: "function (bytes32,bytes32,address)"
										}
									},
									id: 1463,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "9965:37:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 1464,
								nodeType: "EmitStatement",
								src: "9960:42:2"
							}
						]
					},
					documentation: "@dev we are essentially claiming this [id].[table] for the msg.sender, and setting the id createdDate",
					id: 1466,
					implemented: true,
					kind: "function",
					modifiers: [
					],
					name: "_setRowOwner",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 1376,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1371,
								name: "idTableKey",
								nodeType: "VariableDeclaration",
								scope: 1466,
								src: "9348:18:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1370,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "9348:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							},
							{
								constant: false,
								id: 1373,
								name: "id",
								nodeType: "VariableDeclaration",
								scope: 1466,
								src: "9368:10:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1372,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "9368:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							},
							{
								constant: false,
								id: 1375,
								name: "tableKey",
								nodeType: "VariableDeclaration",
								scope: 1466,
								src: "9380:16:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1374,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "9380:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "9347:50:2"
					},
					returnParameters: {
						id: 1377,
						nodeType: "ParameterList",
						parameters: [
						],
						src: "9407:0:2"
					},
					scope: 2289,
					src: "9326:683:2",
					stateMutability: "nonpayable",
					superFunction: null,
					visibility: "internal"
				},
				{
					anonymous: false,
					documentation: null,
					id: 1474,
					name: "InsertRow",
					nodeType: "EventDefinition",
					parameters: {
						id: 1473,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1468,
								indexed: true,
								name: "_id",
								nodeType: "VariableDeclaration",
								scope: 1474,
								src: "10041:19:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1467,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "10041:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							},
							{
								constant: false,
								id: 1470,
								indexed: true,
								name: "_tableKey",
								nodeType: "VariableDeclaration",
								scope: 1474,
								src: "10070:25:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1469,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "10070:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							},
							{
								constant: false,
								id: 1472,
								indexed: true,
								name: "_rowOwner",
								nodeType: "VariableDeclaration",
								scope: 1474,
								src: "10105:25:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_address",
									typeString: "address"
								},
								typeName: {
									id: 1471,
									name: "address",
									nodeType: "ElementaryTypeName",
									src: "10105:7:2",
									stateMutability: "nonpayable",
									typeDescriptions: {
										typeIdentifier: "t_address",
										typeString: "address"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "10031:105:2"
					},
					src: "10015:122:2"
				},
				{
					body: {
						id: 1508,
						nodeType: "Block",
						src: "10239:184:2",
						statements: [
							{
								assignments: [
									1484
								],
								declarations: [
									{
										constant: false,
										id: 1484,
										name: "rowMetadata",
										nodeType: "VariableDeclaration",
										scope: 1508,
										src: "10250:19:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										},
										typeName: {
											id: 1483,
											name: "uint256",
											nodeType: "ElementaryTypeName",
											src: "10250:7:2",
											typeDescriptions: {
												typeIdentifier: "t_uint256",
												typeString: "uint256"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 1491,
								initialValue: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											"arguments": [
												{
													argumentTypes: null,
													id: 1488,
													name: "idTableKey",
													nodeType: "Identifier",
													overloadedDeclarations: [
													],
													referencedDeclaration: 1476,
													src: "10306:10:2",
													typeDescriptions: {
														typeIdentifier: "t_bytes32",
														typeString: "bytes32"
													}
												}
											],
											expression: {
												argumentTypes: [
													{
														typeIdentifier: "t_bytes32",
														typeString: "bytes32"
													}
												],
												expression: {
													argumentTypes: null,
													id: 1486,
													name: "database",
													nodeType: "Identifier",
													overloadedDeclarations: [
													],
													referencedDeclaration: 997,
													src: "10280:8:2",
													typeDescriptions: {
														typeIdentifier: "t_struct$_PolymorphicDictionary_$7490_storage",
														typeString: "struct PolymorphicDictionaryLib.PolymorphicDictionary storage ref"
													}
												},
												id: 1487,
												isConstant: false,
												isLValue: true,
												isPure: false,
												lValueRequested: false,
												memberName: "getBytes32ForKey",
												nodeType: "MemberAccess",
												referencedDeclaration: 7971,
												src: "10280:25:2",
												typeDescriptions: {
													typeIdentifier: "t_function_internal_view$_t_struct$_PolymorphicDictionary_$7490_storage_ptr_$_t_bytes32_$returns$_t_bytes32_$bound_to$_t_struct$_PolymorphicDictionary_$7490_storage_ptr_$",
													typeString: "function (struct PolymorphicDictionaryLib.PolymorphicDictionary storage pointer,bytes32) view returns (bytes32)"
												}
											},
											id: 1489,
											isConstant: false,
											isLValue: false,
											isPure: false,
											kind: "functionCall",
											lValueRequested: false,
											names: [
											],
											nodeType: "FunctionCall",
											src: "10280:37:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										],
										id: 1485,
										isConstant: false,
										isLValue: false,
										isPure: true,
										lValueRequested: false,
										nodeType: "ElementaryTypeNameExpression",
										src: "10272:7:2",
										typeDescriptions: {
											typeIdentifier: "t_type$_t_uint256_$",
											typeString: "type(uint256)"
										},
										typeName: "uint256"
									},
									id: 1490,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "typeConversion",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "10272:46:2",
									typeDescriptions: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "10250:68:2"
							},
							{
								expression: {
									argumentTypes: null,
									id: 1498,
									isConstant: false,
									isLValue: false,
									isPure: false,
									lValueRequested: false,
									leftHandSide: {
										argumentTypes: null,
										id: 1492,
										name: "createdDate",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 1481,
										src: "10329:11:2",
										typeDescriptions: {
											typeIdentifier: "t_bytes4",
											typeString: "bytes4"
										}
									},
									nodeType: "Assignment",
									operator: "=",
									rightHandSide: {
										argumentTypes: null,
										"arguments": [
											{
												argumentTypes: null,
												"arguments": [
													{
														argumentTypes: null,
														id: 1495,
														name: "rowMetadata",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 1484,
														src: "10357:11:2",
														typeDescriptions: {
															typeIdentifier: "t_uint256",
															typeString: "uint256"
														}
													}
												],
												expression: {
													argumentTypes: [
														{
															typeIdentifier: "t_uint256",
															typeString: "uint256"
														}
													],
													id: 1494,
													isConstant: false,
													isLValue: false,
													isPure: true,
													lValueRequested: false,
													nodeType: "ElementaryTypeNameExpression",
													src: "10350:6:2",
													typeDescriptions: {
														typeIdentifier: "t_type$_t_uint32_$",
														typeString: "type(uint32)"
													},
													typeName: "uint32"
												},
												id: 1496,
												isConstant: false,
												isLValue: false,
												isPure: false,
												kind: "typeConversion",
												lValueRequested: false,
												names: [
												],
												nodeType: "FunctionCall",
												src: "10350:19:2",
												typeDescriptions: {
													typeIdentifier: "t_uint32",
													typeString: "uint32"
												}
											}
										],
										expression: {
											argumentTypes: [
												{
													typeIdentifier: "t_uint32",
													typeString: "uint32"
												}
											],
											id: 1493,
											isConstant: false,
											isLValue: false,
											isPure: true,
											lValueRequested: false,
											nodeType: "ElementaryTypeNameExpression",
											src: "10343:6:2",
											typeDescriptions: {
												typeIdentifier: "t_type$_t_bytes4_$",
												typeString: "type(bytes4)"
											},
											typeName: "bytes4"
										},
										id: 1497,
										isConstant: false,
										isLValue: false,
										isPure: false,
										kind: "typeConversion",
										lValueRequested: false,
										names: [
										],
										nodeType: "FunctionCall",
										src: "10343:27:2",
										typeDescriptions: {
											typeIdentifier: "t_bytes4",
											typeString: "bytes4"
										}
									},
									src: "10329:41:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes4",
										typeString: "bytes4"
									}
								},
								id: 1499,
								nodeType: "ExpressionStatement",
								src: "10329:41:2"
							},
							{
								expression: {
									argumentTypes: null,
									id: 1506,
									isConstant: false,
									isLValue: false,
									isPure: false,
									lValueRequested: false,
									leftHandSide: {
										argumentTypes: null,
										id: 1500,
										name: "rowOwner",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 1479,
										src: "10380:8:2",
										typeDescriptions: {
											typeIdentifier: "t_address",
											typeString: "address"
										}
									},
									nodeType: "Assignment",
									operator: "=",
									rightHandSide: {
										argumentTypes: null,
										"arguments": [
											{
												argumentTypes: null,
												commonType: {
													typeIdentifier: "t_uint256",
													typeString: "uint256"
												},
												id: 1504,
												isConstant: false,
												isLValue: false,
												isPure: false,
												lValueRequested: false,
												leftExpression: {
													argumentTypes: null,
													id: 1502,
													name: "rowMetadata",
													nodeType: "Identifier",
													overloadedDeclarations: [
													],
													referencedDeclaration: 1484,
													src: "10399:11:2",
													typeDescriptions: {
														typeIdentifier: "t_uint256",
														typeString: "uint256"
													}
												},
												nodeType: "BinaryOperation",
												operator: ">>",
												rightExpression: {
													argumentTypes: null,
													hexValue: "3332",
													id: 1503,
													isConstant: false,
													isLValue: false,
													isPure: true,
													kind: "number",
													lValueRequested: false,
													nodeType: "Literal",
													src: "10412:2:2",
													subdenomination: null,
													typeDescriptions: {
														typeIdentifier: "t_rational_32_by_1",
														typeString: "int_const 32"
													},
													value: "32"
												},
												src: "10399:15:2",
												typeDescriptions: {
													typeIdentifier: "t_uint256",
													typeString: "uint256"
												}
											}
										],
										expression: {
											argumentTypes: [
												{
													typeIdentifier: "t_uint256",
													typeString: "uint256"
												}
											],
											id: 1501,
											isConstant: false,
											isLValue: false,
											isPure: true,
											lValueRequested: false,
											nodeType: "ElementaryTypeNameExpression",
											src: "10391:7:2",
											typeDescriptions: {
												typeIdentifier: "t_type$_t_address_$",
												typeString: "type(address)"
											},
											typeName: "address"
										},
										id: 1505,
										isConstant: false,
										isLValue: false,
										isPure: false,
										kind: "typeConversion",
										lValueRequested: false,
										names: [
										],
										nodeType: "FunctionCall",
										src: "10391:24:2",
										typeDescriptions: {
											typeIdentifier: "t_address_payable",
											typeString: "address payable"
										}
									},
									src: "10380:35:2",
									typeDescriptions: {
										typeIdentifier: "t_address",
										typeString: "address"
									}
								},
								id: 1507,
								nodeType: "ExpressionStatement",
								src: "10380:35:2"
							}
						]
					},
					documentation: null,
					id: 1509,
					implemented: true,
					kind: "function",
					modifiers: [
					],
					name: "getRowOwner",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 1477,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1476,
								name: "idTableKey",
								nodeType: "VariableDeclaration",
								scope: 1509,
								src: "10164:18:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1475,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "10164:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "10163:20:2"
					},
					returnParameters: {
						id: 1482,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1479,
								name: "rowOwner",
								nodeType: "VariableDeclaration",
								scope: 1509,
								src: "10202:16:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_address",
									typeString: "address"
								},
								typeName: {
									id: 1478,
									name: "address",
									nodeType: "ElementaryTypeName",
									src: "10202:7:2",
									stateMutability: "nonpayable",
									typeDescriptions: {
										typeIdentifier: "t_address",
										typeString: "address"
									}
								},
								value: null,
								visibility: "internal"
							},
							{
								constant: false,
								id: 1481,
								name: "createdDate",
								nodeType: "VariableDeclaration",
								scope: 1509,
								src: "10220:18:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes4",
									typeString: "bytes4"
								},
								typeName: {
									id: 1480,
									name: "bytes4",
									nodeType: "ElementaryTypeName",
									src: "10220:6:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes4",
										typeString: "bytes4"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "10201:38:2"
					},
					scope: 2289,
					src: "10143:280:2",
					stateMutability: "nonpayable",
					superFunction: null,
					visibility: "external"
				},
				{
					body: {
						id: 1605,
						nodeType: "Block",
						src: "10524:1232:2",
						statements: [
							{
								expression: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											commonType: {
												typeIdentifier: "t_bool",
												typeString: "bool"
											},
											id: 1527,
											isConstant: false,
											isLValue: false,
											isPure: false,
											lValueRequested: false,
											leftExpression: {
												argumentTypes: null,
												"arguments": [
													{
														argumentTypes: null,
														id: 1523,
														name: "tableKey",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 1511,
														src: "10571:8:2",
														typeDescriptions: {
															typeIdentifier: "t_bytes32",
															typeString: "bytes32"
														}
													},
													{
														argumentTypes: null,
														id: 1524,
														name: "id",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 1517,
														src: "10581:2:2",
														typeDescriptions: {
															typeIdentifier: "t_bytes32",
															typeString: "bytes32"
														}
													}
												],
												expression: {
													argumentTypes: [
														{
															typeIdentifier: "t_bytes32",
															typeString: "bytes32"
														},
														{
															typeIdentifier: "t_bytes32",
															typeString: "bytes32"
														}
													],
													expression: {
														argumentTypes: null,
														id: 1521,
														name: "tableId",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 986,
														src: "10543:7:2",
														typeDescriptions: {
															typeIdentifier: "t_struct$_Bytes32SetDictionary_$6250_storage",
															typeString: "struct Bytes32SetDictionaryLib.Bytes32SetDictionary storage ref"
														}
													},
													id: 1522,
													isConstant: false,
													isLValue: true,
													isPure: false,
													lValueRequested: false,
													memberName: "containsValueForKey",
													nodeType: "MemberAccess",
													referencedDeclaration: 6437,
													src: "10543:27:2",
													typeDescriptions: {
														typeIdentifier: "t_function_internal_view$_t_struct$_Bytes32SetDictionary_$6250_storage_ptr_$_t_bytes32_$_t_bytes32_$returns$_t_bool_$bound_to$_t_struct$_Bytes32SetDictionary_$6250_storage_ptr_$",
														typeString: "function (struct Bytes32SetDictionaryLib.Bytes32SetDictionary storage pointer,bytes32,bytes32) view returns (bool)"
													}
												},
												id: 1525,
												isConstant: false,
												isLValue: false,
												isPure: false,
												kind: "functionCall",
												lValueRequested: false,
												names: [
												],
												nodeType: "FunctionCall",
												src: "10543:41:2",
												typeDescriptions: {
													typeIdentifier: "t_bool",
													typeString: "bool"
												}
											},
											nodeType: "BinaryOperation",
											operator: "==",
											rightExpression: {
												argumentTypes: null,
												hexValue: "74727565",
												id: 1526,
												isConstant: false,
												isLValue: false,
												isPure: true,
												kind: "bool",
												lValueRequested: false,
												nodeType: "Literal",
												src: "10588:4:2",
												subdenomination: null,
												typeDescriptions: {
													typeIdentifier: "t_bool",
													typeString: "bool"
												},
												value: "true"
											},
											src: "10543:49:2",
											typeDescriptions: {
												typeIdentifier: "t_bool",
												typeString: "bool"
											}
										},
										{
											argumentTypes: null,
											hexValue: "696420646f65736e27742065786973742c2075736520494e53455254",
											id: 1528,
											isConstant: false,
											isLValue: false,
											isPure: true,
											kind: "string",
											lValueRequested: false,
											nodeType: "Literal",
											src: "10594:30:2",
											subdenomination: null,
											typeDescriptions: {
												typeIdentifier: "t_stringliteral_e062c631cebfcba05fea250b6c3bf895a8069dc2ee280d9759ffc17ff124edf6",
												typeString: "literal_string \"id doesn't exist, use INSERT\""
											},
											value: "id doesn't exist, use INSERT"
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bool",
												typeString: "bool"
											},
											{
												typeIdentifier: "t_stringliteral_e062c631cebfcba05fea250b6c3bf895a8069dc2ee280d9759ffc17ff124edf6",
												typeString: "literal_string \"id doesn't exist, use INSERT\""
											}
										],
										id: 1520,
										name: "require",
										nodeType: "Identifier",
										overloadedDeclarations: [
											11011,
											11012
										],
										referencedDeclaration: 11012,
										src: "10535:7:2",
										typeDescriptions: {
											typeIdentifier: "t_function_require_pure$_t_bool_$_t_string_memory_ptr_$returns$__$",
											typeString: "function (bool,string memory) pure"
										}
									},
									id: 1529,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "10535:90:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 1530,
								nodeType: "ExpressionStatement",
								src: "10535:90:2"
							},
							{
								assignments: [
									1532,
									1534
								],
								declarations: [
									{
										constant: false,
										id: 1532,
										name: "permission",
										nodeType: "VariableDeclaration",
										scope: 1605,
										src: "10637:18:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										},
										typeName: {
											id: 1531,
											name: "uint256",
											nodeType: "ElementaryTypeName",
											src: "10637:7:2",
											typeDescriptions: {
												typeIdentifier: "t_uint256",
												typeString: "uint256"
											}
										},
										value: null,
										visibility: "internal"
									},
									{
										constant: false,
										id: 1534,
										name: "delegate",
										nodeType: "VariableDeclaration",
										scope: 1605,
										src: "10657:16:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_address",
											typeString: "address"
										},
										typeName: {
											id: 1533,
											name: "address",
											nodeType: "ElementaryTypeName",
											src: "10657:7:2",
											stateMutability: "nonpayable",
											typeDescriptions: {
												typeIdentifier: "t_address",
												typeString: "address"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 1538,
								initialValue: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1536,
											name: "tableKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1511,
											src: "10694:8:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										],
										id: 1535,
										name: "getTableMetadata",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 2003,
										src: "10677:16:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_view$_t_bytes32_$returns$_t_uint256_$_t_address_$",
											typeString: "function (bytes32) view returns (uint256,address)"
										}
									},
									id: 1537,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "10677:26:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$_t_uint256_$_t_address_$",
										typeString: "tuple(uint256,address)"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "10636:67:2"
							},
							{
								expression: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											commonType: {
												typeIdentifier: "t_uint256",
												typeString: "uint256"
											},
											id: 1542,
											isConstant: false,
											isLValue: false,
											isPure: false,
											lValueRequested: false,
											leftExpression: {
												argumentTypes: null,
												id: 1540,
												name: "permission",
												nodeType: "Identifier",
												overloadedDeclarations: [
												],
												referencedDeclaration: 1532,
												src: "10786:10:2",
												typeDescriptions: {
													typeIdentifier: "t_uint256",
													typeString: "uint256"
												}
											},
											nodeType: "BinaryOperation",
											operator: ">",
											rightExpression: {
												argumentTypes: null,
												hexValue: "30",
												id: 1541,
												isConstant: false,
												isLValue: false,
												isPure: true,
												kind: "number",
												lValueRequested: false,
												nodeType: "Literal",
												src: "10799:1:2",
												subdenomination: null,
												typeDescriptions: {
													typeIdentifier: "t_rational_0_by_1",
													typeString: "int_const 0"
												},
												value: "0"
											},
											src: "10786:14:2",
											typeDescriptions: {
												typeIdentifier: "t_bool",
												typeString: "bool"
											}
										},
										{
											argumentTypes: null,
											hexValue: "43616e6e6f74205550444154452073797374656d207461626c65",
											id: 1543,
											isConstant: false,
											isLValue: false,
											isPure: true,
											kind: "string",
											lValueRequested: false,
											nodeType: "Literal",
											src: "10802:28:2",
											subdenomination: null,
											typeDescriptions: {
												typeIdentifier: "t_stringliteral_1fb6cfc287a881526d28c733853bf507a7d955871af98ab667d0dc8dcd08d8eb",
												typeString: "literal_string \"Cannot UPDATE system table\""
											},
											value: "Cannot UPDATE system table"
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bool",
												typeString: "bool"
											},
											{
												typeIdentifier: "t_stringliteral_1fb6cfc287a881526d28c733853bf507a7d955871af98ab667d0dc8dcd08d8eb",
												typeString: "literal_string \"Cannot UPDATE system table\""
											}
										],
										id: 1539,
										name: "require",
										nodeType: "Identifier",
										overloadedDeclarations: [
											11011,
											11012
										],
										referencedDeclaration: 11012,
										src: "10778:7:2",
										typeDescriptions: {
											typeIdentifier: "t_function_require_pure$_t_bool_$_t_string_memory_ptr_$returns$__$",
											typeString: "function (bool,string memory) pure"
										}
									},
									id: 1544,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "10778:53:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 1545,
								nodeType: "ExpressionStatement",
								src: "10778:53:2"
							},
							{
								expression: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											commonType: {
												typeIdentifier: "t_bool",
												typeString: "bool"
											},
											id: 1559,
											isConstant: false,
											isLValue: false,
											isPure: false,
											lValueRequested: false,
											leftExpression: {
												argumentTypes: null,
												commonType: {
													typeIdentifier: "t_bool",
													typeString: "bool"
												},
												id: 1554,
												isConstant: false,
												isLValue: false,
												isPure: false,
												lValueRequested: false,
												leftExpression: {
													argumentTypes: null,
													commonType: {
														typeIdentifier: "t_uint256",
														typeString: "uint256"
													},
													id: 1549,
													isConstant: false,
													isLValue: false,
													isPure: false,
													lValueRequested: false,
													leftExpression: {
														argumentTypes: null,
														id: 1547,
														name: "permission",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 1532,
														src: "10910:10:2",
														typeDescriptions: {
															typeIdentifier: "t_uint256",
															typeString: "uint256"
														}
													},
													nodeType: "BinaryOperation",
													operator: ">",
													rightExpression: {
														argumentTypes: null,
														hexValue: "31",
														id: 1548,
														isConstant: false,
														isLValue: false,
														isPure: true,
														kind: "number",
														lValueRequested: false,
														nodeType: "Literal",
														src: "10923:1:2",
														subdenomination: null,
														typeDescriptions: {
															typeIdentifier: "t_rational_1_by_1",
															typeString: "int_const 1"
														},
														value: "1"
													},
													src: "10910:14:2",
													typeDescriptions: {
														typeIdentifier: "t_bool",
														typeString: "bool"
													}
												},
												nodeType: "BinaryOperation",
												operator: "||",
												rightExpression: {
													argumentTypes: null,
													commonType: {
														typeIdentifier: "t_bool",
														typeString: "bool"
													},
													id: 1553,
													isConstant: false,
													isLValue: false,
													isPure: false,
													lValueRequested: false,
													leftExpression: {
														argumentTypes: null,
														"arguments": [
														],
														expression: {
															argumentTypes: [
															],
															id: 1550,
															name: "isOwner",
															nodeType: "Identifier",
															overloadedDeclarations: [
															],
															referencedDeclaration: 5016,
															src: "10928:7:2",
															typeDescriptions: {
																typeIdentifier: "t_function_internal_view$__$returns$_t_bool_$",
																typeString: "function () view returns (bool)"
															}
														},
														id: 1551,
														isConstant: false,
														isLValue: false,
														isPure: false,
														kind: "functionCall",
														lValueRequested: false,
														names: [
														],
														nodeType: "FunctionCall",
														src: "10928:9:2",
														typeDescriptions: {
															typeIdentifier: "t_bool",
															typeString: "bool"
														}
													},
													nodeType: "BinaryOperation",
													operator: "==",
													rightExpression: {
														argumentTypes: null,
														hexValue: "74727565",
														id: 1552,
														isConstant: false,
														isLValue: false,
														isPure: true,
														kind: "bool",
														lValueRequested: false,
														nodeType: "Literal",
														src: "10941:4:2",
														subdenomination: null,
														typeDescriptions: {
															typeIdentifier: "t_bool",
															typeString: "bool"
														},
														value: "true"
													},
													src: "10928:17:2",
													typeDescriptions: {
														typeIdentifier: "t_bool",
														typeString: "bool"
													}
												},
												src: "10910:35:2",
												typeDescriptions: {
													typeIdentifier: "t_bool",
													typeString: "bool"
												}
											},
											nodeType: "BinaryOperation",
											operator: "||",
											rightExpression: {
												argumentTypes: null,
												commonType: {
													typeIdentifier: "t_address",
													typeString: "address"
												},
												id: 1558,
												isConstant: false,
												isLValue: false,
												isPure: false,
												lValueRequested: false,
												leftExpression: {
													argumentTypes: null,
													id: 1555,
													name: "delegate",
													nodeType: "Identifier",
													overloadedDeclarations: [
													],
													referencedDeclaration: 1534,
													src: "10949:8:2",
													typeDescriptions: {
														typeIdentifier: "t_address",
														typeString: "address"
													}
												},
												nodeType: "BinaryOperation",
												operator: "==",
												rightExpression: {
													argumentTypes: null,
													"arguments": [
													],
													expression: {
														argumentTypes: [
														],
														id: 1556,
														name: "_msgSender",
														nodeType: "Identifier",
														overloadedDeclarations: [
															3607
														],
														referencedDeclaration: 3607,
														src: "10961:10:2",
														typeDescriptions: {
															typeIdentifier: "t_function_internal_view$__$returns$_t_address_$",
															typeString: "function () view returns (address)"
														}
													},
													id: 1557,
													isConstant: false,
													isLValue: false,
													isPure: false,
													kind: "functionCall",
													lValueRequested: false,
													names: [
													],
													nodeType: "FunctionCall",
													src: "10961:12:2",
													typeDescriptions: {
														typeIdentifier: "t_address",
														typeString: "address"
													}
												},
												src: "10949:24:2",
												typeDescriptions: {
													typeIdentifier: "t_bool",
													typeString: "bool"
												}
											},
											src: "10910:63:2",
											typeDescriptions: {
												typeIdentifier: "t_bool",
												typeString: "bool"
											}
										},
										{
											argumentTypes: null,
											hexValue: "4f6e6c79206f776e65722f64656c65676174652063616e2055504441544520696e746f2074686973207461626c65",
											id: 1560,
											isConstant: false,
											isLValue: false,
											isPure: true,
											kind: "string",
											lValueRequested: false,
											nodeType: "Literal",
											src: "10975:48:2",
											subdenomination: null,
											typeDescriptions: {
												typeIdentifier: "t_stringliteral_41d537d2cf51ebb4c64ddf99f5e6ba67c43bcb89a0eb79039efa385d59e725e8",
												typeString: "literal_string \"Only owner/delegate can UPDATE into this table\""
											},
											value: "Only owner/delegate can UPDATE into this table"
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bool",
												typeString: "bool"
											},
											{
												typeIdentifier: "t_stringliteral_41d537d2cf51ebb4c64ddf99f5e6ba67c43bcb89a0eb79039efa385d59e725e8",
												typeString: "literal_string \"Only owner/delegate can UPDATE into this table\""
											}
										],
										id: 1546,
										name: "require",
										nodeType: "Identifier",
										overloadedDeclarations: [
											11011,
											11012
										],
										referencedDeclaration: 11012,
										src: "10902:7:2",
										typeDescriptions: {
											typeIdentifier: "t_function_require_pure$_t_bool_$_t_string_memory_ptr_$returns$__$",
											typeString: "function (bool,string memory) pure"
										}
									},
									id: 1561,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "10902:122:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 1562,
								nodeType: "ExpressionStatement",
								src: "10902:122:2"
							},
							{
								condition: {
									argumentTypes: null,
									commonType: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									},
									id: 1565,
									isConstant: false,
									isLValue: false,
									isPure: false,
									lValueRequested: false,
									leftExpression: {
										argumentTypes: null,
										id: 1563,
										name: "permission",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 1532,
										src: "11198:10:2",
										typeDescriptions: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										}
									},
									nodeType: "BinaryOperation",
									operator: ">=",
									rightExpression: {
										argumentTypes: null,
										hexValue: "32",
										id: 1564,
										isConstant: false,
										isLValue: false,
										isPure: true,
										kind: "number",
										lValueRequested: false,
										nodeType: "Literal",
										src: "11212:1:2",
										subdenomination: null,
										typeDescriptions: {
											typeIdentifier: "t_rational_2_by_1",
											typeString: "int_const 2"
										},
										value: "2"
									},
									src: "11198:15:2",
									typeDescriptions: {
										typeIdentifier: "t_bool",
										typeString: "bool"
									}
								},
								falseBody: null,
								id: 1604,
								nodeType: "IfStatement",
								src: "11194:556:2",
								trueBody: {
									id: 1603,
									nodeType: "Block",
									src: "11215:535:2",
									statements: [
										{
											assignments: [
												1567
											],
											declarations: [
												{
													constant: false,
													id: 1567,
													name: "rowMetaData",
													nodeType: "VariableDeclaration",
													scope: 1603,
													src: "11311:19:2",
													stateVariable: false,
													storageLocation: "default",
													typeDescriptions: {
														typeIdentifier: "t_bytes32",
														typeString: "bytes32"
													},
													typeName: {
														id: 1566,
														name: "bytes32",
														nodeType: "ElementaryTypeName",
														src: "11311:7:2",
														typeDescriptions: {
															typeIdentifier: "t_bytes32",
															typeString: "bytes32"
														}
													},
													value: null,
													visibility: "internal"
												}
											],
											id: 1572,
											initialValue: {
												argumentTypes: null,
												"arguments": [
													{
														argumentTypes: null,
														id: 1570,
														name: "idTableKey",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 1515,
														src: "11359:10:2",
														typeDescriptions: {
															typeIdentifier: "t_bytes32",
															typeString: "bytes32"
														}
													}
												],
												expression: {
													argumentTypes: [
														{
															typeIdentifier: "t_bytes32",
															typeString: "bytes32"
														}
													],
													expression: {
														argumentTypes: null,
														id: 1568,
														name: "database",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 997,
														src: "11333:8:2",
														typeDescriptions: {
															typeIdentifier: "t_struct$_PolymorphicDictionary_$7490_storage",
															typeString: "struct PolymorphicDictionaryLib.PolymorphicDictionary storage ref"
														}
													},
													id: 1569,
													isConstant: false,
													isLValue: true,
													isPure: false,
													lValueRequested: false,
													memberName: "getBytes32ForKey",
													nodeType: "MemberAccess",
													referencedDeclaration: 7971,
													src: "11333:25:2",
													typeDescriptions: {
														typeIdentifier: "t_function_internal_view$_t_struct$_PolymorphicDictionary_$7490_storage_ptr_$_t_bytes32_$returns$_t_bytes32_$bound_to$_t_struct$_PolymorphicDictionary_$7490_storage_ptr_$",
														typeString: "function (struct PolymorphicDictionaryLib.PolymorphicDictionary storage pointer,bytes32) view returns (bytes32)"
													}
												},
												id: 1571,
												isConstant: false,
												isLValue: false,
												isPure: false,
												kind: "functionCall",
												lValueRequested: false,
												names: [
												],
												nodeType: "FunctionCall",
												src: "11333:37:2",
												typeDescriptions: {
													typeIdentifier: "t_bytes32",
													typeString: "bytes32"
												}
											},
											nodeType: "VariableDeclarationStatement",
											src: "11311:59:2"
										},
										{
											assignments: [
												1574
											],
											declarations: [
												{
													constant: false,
													id: 1574,
													name: "rowOwner",
													nodeType: "VariableDeclaration",
													scope: 1603,
													src: "11384:16:2",
													stateVariable: false,
													storageLocation: "default",
													typeDescriptions: {
														typeIdentifier: "t_address",
														typeString: "address"
													},
													typeName: {
														id: 1573,
														name: "address",
														nodeType: "ElementaryTypeName",
														src: "11384:7:2",
														stateMutability: "nonpayable",
														typeDescriptions: {
															typeIdentifier: "t_address",
															typeString: "address"
														}
													},
													value: null,
													visibility: "internal"
												}
											],
											id: 1582,
											initialValue: {
												argumentTypes: null,
												"arguments": [
													{
														argumentTypes: null,
														commonType: {
															typeIdentifier: "t_uint256",
															typeString: "uint256"
														},
														id: 1580,
														isConstant: false,
														isLValue: false,
														isPure: false,
														lValueRequested: false,
														leftExpression: {
															argumentTypes: null,
															"arguments": [
																{
																	argumentTypes: null,
																	id: 1577,
																	name: "rowMetaData",
																	nodeType: "Identifier",
																	overloadedDeclarations: [
																	],
																	referencedDeclaration: 1567,
																	src: "11419:11:2",
																	typeDescriptions: {
																		typeIdentifier: "t_bytes32",
																		typeString: "bytes32"
																	}
																}
															],
															expression: {
																argumentTypes: [
																	{
																		typeIdentifier: "t_bytes32",
																		typeString: "bytes32"
																	}
																],
																id: 1576,
																isConstant: false,
																isLValue: false,
																isPure: true,
																lValueRequested: false,
																nodeType: "ElementaryTypeNameExpression",
																src: "11411:7:2",
																typeDescriptions: {
																	typeIdentifier: "t_type$_t_uint256_$",
																	typeString: "type(uint256)"
																},
																typeName: "uint256"
															},
															id: 1578,
															isConstant: false,
															isLValue: false,
															isPure: false,
															kind: "typeConversion",
															lValueRequested: false,
															names: [
															],
															nodeType: "FunctionCall",
															src: "11411:20:2",
															typeDescriptions: {
																typeIdentifier: "t_uint256",
																typeString: "uint256"
															}
														},
														nodeType: "BinaryOperation",
														operator: ">>",
														rightExpression: {
															argumentTypes: null,
															hexValue: "3332",
															id: 1579,
															isConstant: false,
															isLValue: false,
															isPure: true,
															kind: "number",
															lValueRequested: false,
															nodeType: "Literal",
															src: "11433:2:2",
															subdenomination: null,
															typeDescriptions: {
																typeIdentifier: "t_rational_32_by_1",
																typeString: "int_const 32"
															},
															value: "32"
														},
														src: "11411:24:2",
														typeDescriptions: {
															typeIdentifier: "t_uint256",
															typeString: "uint256"
														}
													}
												],
												expression: {
													argumentTypes: [
														{
															typeIdentifier: "t_uint256",
															typeString: "uint256"
														}
													],
													id: 1575,
													isConstant: false,
													isLValue: false,
													isPure: true,
													lValueRequested: false,
													nodeType: "ElementaryTypeNameExpression",
													src: "11403:7:2",
													typeDescriptions: {
														typeIdentifier: "t_type$_t_address_$",
														typeString: "type(address)"
													},
													typeName: "address"
												},
												id: 1581,
												isConstant: false,
												isLValue: false,
												isPure: false,
												kind: "typeConversion",
												lValueRequested: false,
												names: [
												],
												nodeType: "FunctionCall",
												src: "11403:33:2",
												typeDescriptions: {
													typeIdentifier: "t_address_payable",
													typeString: "address payable"
												}
											},
											nodeType: "VariableDeclarationStatement",
											src: "11384:52:2"
										},
										{
											condition: {
												argumentTypes: null,
												commonType: {
													typeIdentifier: "t_address",
													typeString: "address"
												},
												id: 1586,
												isConstant: false,
												isLValue: false,
												isPure: false,
												lValueRequested: false,
												leftExpression: {
													argumentTypes: null,
													id: 1583,
													name: "rowOwner",
													nodeType: "Identifier",
													overloadedDeclarations: [
													],
													referencedDeclaration: 1574,
													src: "11522:8:2",
													typeDescriptions: {
														typeIdentifier: "t_address",
														typeString: "address"
													}
												},
												nodeType: "BinaryOperation",
												operator: "==",
												rightExpression: {
													argumentTypes: null,
													"arguments": [
													],
													expression: {
														argumentTypes: [
														],
														id: 1584,
														name: "_msgSender",
														nodeType: "Identifier",
														overloadedDeclarations: [
															3607
														],
														referencedDeclaration: 3607,
														src: "11534:10:2",
														typeDescriptions: {
															typeIdentifier: "t_function_internal_view$__$returns$_t_address_$",
															typeString: "function () view returns (address)"
														}
													},
													id: 1585,
													isConstant: false,
													isLValue: false,
													isPure: false,
													kind: "functionCall",
													lValueRequested: false,
													names: [
													],
													nodeType: "FunctionCall",
													src: "11534:12:2",
													typeDescriptions: {
														typeIdentifier: "t_address",
														typeString: "address"
													}
												},
												src: "11522:24:2",
												typeDescriptions: {
													typeIdentifier: "t_bool",
													typeString: "bool"
												}
											},
											falseBody: {
												id: 1601,
												nodeType: "Block",
												src: "11592:148:2",
												statements: [
													{
														expression: {
															argumentTypes: null,
															"arguments": [
																{
																	argumentTypes: null,
																	commonType: {
																		typeIdentifier: "t_bool",
																		typeString: "bool"
																	},
																	id: 1597,
																	isConstant: false,
																	isLValue: false,
																	isPure: false,
																	lValueRequested: false,
																	leftExpression: {
																		argumentTypes: null,
																		commonType: {
																			typeIdentifier: "t_bool",
																			typeString: "bool"
																		},
																		id: 1592,
																		isConstant: false,
																		isLValue: false,
																		isPure: false,
																		lValueRequested: false,
																		leftExpression: {
																			argumentTypes: null,
																			"arguments": [
																			],
																			expression: {
																				argumentTypes: [
																				],
																				id: 1589,
																				name: "isOwner",
																				nodeType: "Identifier",
																				overloadedDeclarations: [
																				],
																				referencedDeclaration: 5016,
																				src: "11618:7:2",
																				typeDescriptions: {
																					typeIdentifier: "t_function_internal_view$__$returns$_t_bool_$",
																					typeString: "function () view returns (bool)"
																				}
																			},
																			id: 1590,
																			isConstant: false,
																			isLValue: false,
																			isPure: false,
																			kind: "functionCall",
																			lValueRequested: false,
																			names: [
																			],
																			nodeType: "FunctionCall",
																			src: "11618:9:2",
																			typeDescriptions: {
																				typeIdentifier: "t_bool",
																				typeString: "bool"
																			}
																		},
																		nodeType: "BinaryOperation",
																		operator: "==",
																		rightExpression: {
																			argumentTypes: null,
																			hexValue: "74727565",
																			id: 1591,
																			isConstant: false,
																			isLValue: false,
																			isPure: true,
																			kind: "bool",
																			lValueRequested: false,
																			nodeType: "Literal",
																			src: "11631:4:2",
																			subdenomination: null,
																			typeDescriptions: {
																				typeIdentifier: "t_bool",
																				typeString: "bool"
																			},
																			value: "true"
																		},
																		src: "11618:17:2",
																		typeDescriptions: {
																			typeIdentifier: "t_bool",
																			typeString: "bool"
																		}
																	},
																	nodeType: "BinaryOperation",
																	operator: "||",
																	rightExpression: {
																		argumentTypes: null,
																		commonType: {
																			typeIdentifier: "t_address",
																			typeString: "address"
																		},
																		id: 1596,
																		isConstant: false,
																		isLValue: false,
																		isPure: false,
																		lValueRequested: false,
																		leftExpression: {
																			argumentTypes: null,
																			id: 1593,
																			name: "delegate",
																			nodeType: "Identifier",
																			overloadedDeclarations: [
																			],
																			referencedDeclaration: 1534,
																			src: "11639:8:2",
																			typeDescriptions: {
																				typeIdentifier: "t_address",
																				typeString: "address"
																			}
																		},
																		nodeType: "BinaryOperation",
																		operator: "==",
																		rightExpression: {
																			argumentTypes: null,
																			"arguments": [
																			],
																			expression: {
																				argumentTypes: [
																				],
																				id: 1594,
																				name: "_msgSender",
																				nodeType: "Identifier",
																				overloadedDeclarations: [
																					3607
																				],
																				referencedDeclaration: 3607,
																				src: "11651:10:2",
																				typeDescriptions: {
																					typeIdentifier: "t_function_internal_view$__$returns$_t_address_$",
																					typeString: "function () view returns (address)"
																				}
																			},
																			id: 1595,
																			isConstant: false,
																			isLValue: false,
																			isPure: false,
																			kind: "functionCall",
																			lValueRequested: false,
																			names: [
																			],
																			nodeType: "FunctionCall",
																			src: "11651:12:2",
																			typeDescriptions: {
																				typeIdentifier: "t_address",
																				typeString: "address"
																			}
																		},
																		src: "11639:24:2",
																		typeDescriptions: {
																			typeIdentifier: "t_bool",
																			typeString: "bool"
																		}
																	},
																	src: "11618:45:2",
																	typeDescriptions: {
																		typeIdentifier: "t_bool",
																		typeString: "bool"
																	}
																},
																{
																	argumentTypes: null,
																	hexValue: "4e6f7420726f774f776e6572206f72206f776e65722f64656c656761746520666f722055504441544520696e746f2074686973207461626c65",
																	id: 1598,
																	isConstant: false,
																	isLValue: false,
																	isPure: true,
																	kind: "string",
																	lValueRequested: false,
																	nodeType: "Literal",
																	src: "11665:59:2",
																	subdenomination: null,
																	typeDescriptions: {
																		typeIdentifier: "t_stringliteral_627ce0c74b5075c1ccd59f2bdb6411a148fdf65d04b3c288101b934a5fb8eae0",
																		typeString: "literal_string \"Not rowOwner or owner/delegate for UPDATE into this table\""
																	},
																	value: "Not rowOwner or owner/delegate for UPDATE into this table"
																}
															],
															expression: {
																argumentTypes: [
																	{
																		typeIdentifier: "t_bool",
																		typeString: "bool"
																	},
																	{
																		typeIdentifier: "t_stringliteral_627ce0c74b5075c1ccd59f2bdb6411a148fdf65d04b3c288101b934a5fb8eae0",
																		typeString: "literal_string \"Not rowOwner or owner/delegate for UPDATE into this table\""
																	}
																],
																id: 1588,
																name: "require",
																nodeType: "Identifier",
																overloadedDeclarations: [
																	11011,
																	11012
																],
																referencedDeclaration: 11012,
																src: "11610:7:2",
																typeDescriptions: {
																	typeIdentifier: "t_function_require_pure$_t_bool_$_t_string_memory_ptr_$returns$__$",
																	typeString: "function (bool,string memory) pure"
																}
															},
															id: 1599,
															isConstant: false,
															isLValue: false,
															isPure: false,
															kind: "functionCall",
															lValueRequested: false,
															names: [
															],
															nodeType: "FunctionCall",
															src: "11610:115:2",
															typeDescriptions: {
																typeIdentifier: "t_tuple$__$",
																typeString: "tuple()"
															}
														},
														id: 1600,
														nodeType: "ExpressionStatement",
														src: "11610:115:2"
													}
												]
											},
											id: 1602,
											nodeType: "IfStatement",
											src: "11518:222:2",
											trueBody: {
												id: 1587,
												nodeType: "Block",
												src: "11547:39:2",
												statements: [
												]
											}
										}
									]
								}
							}
						]
					},
					documentation: null,
					id: 1606,
					implemented: true,
					kind: "function",
					modifiers: [
					],
					name: "updateCheck",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 1518,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1511,
								name: "tableKey",
								nodeType: "VariableDeclaration",
								scope: 1606,
								src: "10450:16:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1510,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "10450:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							},
							{
								constant: false,
								id: 1513,
								name: "idKey",
								nodeType: "VariableDeclaration",
								scope: 1606,
								src: "10468:13:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1512,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "10468:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							},
							{
								constant: false,
								id: 1515,
								name: "idTableKey",
								nodeType: "VariableDeclaration",
								scope: 1606,
								src: "10483:18:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1514,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "10483:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							},
							{
								constant: false,
								id: 1517,
								name: "id",
								nodeType: "VariableDeclaration",
								scope: 1606,
								src: "10503:10:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1516,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "10503:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "10449:65:2"
					},
					returnParameters: {
						id: 1519,
						nodeType: "ParameterList",
						parameters: [
						],
						src: "10524:0:2"
					},
					scope: 2289,
					src: "10429:1327:2",
					stateMutability: "nonpayable",
					superFunction: null,
					visibility: "internal"
				},
				{
					body: {
						id: 1652,
						nodeType: "Block",
						src: "11912:343:2",
						statements: [
							{
								assignments: [
									1620
								],
								declarations: [
									{
										constant: false,
										id: 1620,
										name: "idTableKey",
										nodeType: "VariableDeclaration",
										scope: 1652,
										src: "11923:18:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_bytes32",
											typeString: "bytes32"
										},
										typeName: {
											id: 1619,
											name: "bytes32",
											nodeType: "ElementaryTypeName",
											src: "11923:7:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 1625,
								initialValue: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1622,
											name: "idKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1610,
											src: "11953:5:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										{
											argumentTypes: null,
											id: 1623,
											name: "tableKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1608,
											src: "11960:8:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											},
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										],
										id: 1621,
										name: "namehash",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 1960,
										src: "11944:8:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_pure$_t_bytes32_$_t_bytes32_$returns$_t_bytes32_$",
											typeString: "function (bytes32,bytes32) pure returns (bytes32)"
										}
									},
									id: 1624,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "11944:25:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "11923:46:2"
							},
							{
								assignments: [
									1627
								],
								declarations: [
									{
										constant: false,
										id: 1627,
										name: "fieldIdTableKey",
										nodeType: "VariableDeclaration",
										scope: 1652,
										src: "11979:23:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_bytes32",
											typeString: "bytes32"
										},
										typeName: {
											id: 1626,
											name: "bytes32",
											nodeType: "ElementaryTypeName",
											src: "11979:7:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 1632,
								initialValue: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1629,
											name: "fieldKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1612,
											src: "12014:8:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										{
											argumentTypes: null,
											id: 1630,
											name: "idTableKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1620,
											src: "12024:10:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											},
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										],
										id: 1628,
										name: "namehash",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 1960,
										src: "12005:8:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_pure$_t_bytes32_$_t_bytes32_$returns$_t_bytes32_$",
											typeString: "function (bytes32,bytes32) pure returns (bytes32)"
										}
									},
									id: 1631,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "12005:30:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "11979:56:2"
							},
							{
								expression: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1634,
											name: "tableKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1608,
											src: "12058:8:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										{
											argumentTypes: null,
											id: 1635,
											name: "idKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1610,
											src: "12068:5:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										{
											argumentTypes: null,
											id: 1636,
											name: "idTableKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1620,
											src: "12075:10:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										{
											argumentTypes: null,
											id: 1637,
											name: "id",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1614,
											src: "12087:2:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											},
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											},
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											},
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										],
										id: 1633,
										name: "updateCheck",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 1606,
										src: "12046:11:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_nonpayable$_t_bytes32_$_t_bytes32_$_t_bytes32_$_t_bytes32_$returns$__$",
											typeString: "function (bytes32,bytes32,bytes32,bytes32)"
										}
									},
									id: 1638,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "12046:44:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 1639,
								nodeType: "ExpressionStatement",
								src: "12046:44:2"
							},
							{
								expression: {
									argumentTypes: null,
									"arguments": [
									],
									expression: {
										argumentTypes: [
										],
										id: 1640,
										name: "increaseGsnCounter",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 2128,
										src: "12130:18:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_nonpayable$__$returns$__$",
											typeString: "function ()"
										}
									},
									id: 1641,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "12130:20:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 1642,
								nodeType: "ExpressionStatement",
								src: "12130:20:2"
							},
							{
								expression: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1646,
											name: "fieldIdTableKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1627,
											src: "12217:15:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										{
											argumentTypes: null,
											"arguments": [
												{
													argumentTypes: null,
													id: 1648,
													name: "val",
													nodeType: "Identifier",
													overloadedDeclarations: [
													],
													referencedDeclaration: 1616,
													src: "12242:3:2",
													typeDescriptions: {
														typeIdentifier: "t_bytes32",
														typeString: "bytes32"
													}
												}
											],
											expression: {
												argumentTypes: [
													{
														typeIdentifier: "t_bytes32",
														typeString: "bytes32"
													}
												],
												id: 1647,
												isConstant: false,
												isLValue: false,
												isPure: true,
												lValueRequested: false,
												nodeType: "ElementaryTypeNameExpression",
												src: "12234:7:2",
												typeDescriptions: {
													typeIdentifier: "t_type$_t_bytes32_$",
													typeString: "type(bytes32)"
												},
												typeName: "bytes32"
											},
											id: 1649,
											isConstant: false,
											isLValue: false,
											isPure: false,
											kind: "typeConversion",
											lValueRequested: false,
											names: [
											],
											nodeType: "FunctionCall",
											src: "12234:12:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											},
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										],
										expression: {
											argumentTypes: null,
											id: 1643,
											name: "database",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 997,
											src: "12193:8:2",
											typeDescriptions: {
												typeIdentifier: "t_struct$_PolymorphicDictionary_$7490_storage",
												typeString: "struct PolymorphicDictionaryLib.PolymorphicDictionary storage ref"
											}
										},
										id: 1645,
										isConstant: false,
										isLValue: true,
										isPure: false,
										lValueRequested: false,
										memberName: "setValueForKey",
										nodeType: "MemberAccess",
										referencedDeclaration: 8456,
										src: "12193:23:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_nonpayable$_t_struct$_PolymorphicDictionary_$7490_storage_ptr_$_t_bytes32_$_t_bytes32_$returns$_t_bool_$bound_to$_t_struct$_PolymorphicDictionary_$7490_storage_ptr_$",
											typeString: "function (struct PolymorphicDictionaryLib.PolymorphicDictionary storage pointer,bytes32,bytes32) returns (bool)"
										}
									},
									id: 1650,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "12193:54:2",
									typeDescriptions: {
										typeIdentifier: "t_bool",
										typeString: "bool"
									}
								},
								id: 1651,
								nodeType: "ExpressionStatement",
								src: "12193:54:2"
							}
						]
					},
					documentation: null,
					id: 1653,
					implemented: true,
					kind: "function",
					modifiers: [
					],
					name: "updateVal",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 1617,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1608,
								name: "tableKey",
								nodeType: "VariableDeclaration",
								scope: 1653,
								src: "11791:16:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1607,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "11791:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							},
							{
								constant: false,
								id: 1610,
								name: "idKey",
								nodeType: "VariableDeclaration",
								scope: 1653,
								src: "11817:13:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1609,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "11817:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							},
							{
								constant: false,
								id: 1612,
								name: "fieldKey",
								nodeType: "VariableDeclaration",
								scope: 1653,
								src: "11840:16:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1611,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "11840:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							},
							{
								constant: false,
								id: 1614,
								name: "id",
								nodeType: "VariableDeclaration",
								scope: 1653,
								src: "11867:10:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1613,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "11867:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							},
							{
								constant: false,
								id: 1616,
								name: "val",
								nodeType: "VariableDeclaration",
								scope: 1653,
								src: "11887:11:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1615,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "11887:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "11780:119:2"
					},
					returnParameters: {
						id: 1618,
						nodeType: "ParameterList",
						parameters: [
						],
						src: "11912:0:2"
					},
					scope: 2289,
					src: "11762:493:2",
					stateMutability: "nonpayable",
					superFunction: null,
					visibility: "public"
				},
				{
					body: {
						id: 1747,
						nodeType: "Block",
						src: "12356:1126:2",
						statements: [
							{
								expression: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											commonType: {
												typeIdentifier: "t_bool",
												typeString: "bool"
											},
											id: 1671,
											isConstant: false,
											isLValue: false,
											isPure: false,
											lValueRequested: false,
											leftExpression: {
												argumentTypes: null,
												"arguments": [
													{
														argumentTypes: null,
														id: 1667,
														name: "tableKey",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 1655,
														src: "12403:8:2",
														typeDescriptions: {
															typeIdentifier: "t_bytes32",
															typeString: "bytes32"
														}
													},
													{
														argumentTypes: null,
														id: 1668,
														name: "id",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 1661,
														src: "12413:2:2",
														typeDescriptions: {
															typeIdentifier: "t_bytes32",
															typeString: "bytes32"
														}
													}
												],
												expression: {
													argumentTypes: [
														{
															typeIdentifier: "t_bytes32",
															typeString: "bytes32"
														},
														{
															typeIdentifier: "t_bytes32",
															typeString: "bytes32"
														}
													],
													expression: {
														argumentTypes: null,
														id: 1665,
														name: "tableId",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 986,
														src: "12375:7:2",
														typeDescriptions: {
															typeIdentifier: "t_struct$_Bytes32SetDictionary_$6250_storage",
															typeString: "struct Bytes32SetDictionaryLib.Bytes32SetDictionary storage ref"
														}
													},
													id: 1666,
													isConstant: false,
													isLValue: true,
													isPure: false,
													lValueRequested: false,
													memberName: "containsValueForKey",
													nodeType: "MemberAccess",
													referencedDeclaration: 6437,
													src: "12375:27:2",
													typeDescriptions: {
														typeIdentifier: "t_function_internal_view$_t_struct$_Bytes32SetDictionary_$6250_storage_ptr_$_t_bytes32_$_t_bytes32_$returns$_t_bool_$bound_to$_t_struct$_Bytes32SetDictionary_$6250_storage_ptr_$",
														typeString: "function (struct Bytes32SetDictionaryLib.Bytes32SetDictionary storage pointer,bytes32,bytes32) view returns (bool)"
													}
												},
												id: 1669,
												isConstant: false,
												isLValue: false,
												isPure: false,
												kind: "functionCall",
												lValueRequested: false,
												names: [
												],
												nodeType: "FunctionCall",
												src: "12375:41:2",
												typeDescriptions: {
													typeIdentifier: "t_bool",
													typeString: "bool"
												}
											},
											nodeType: "BinaryOperation",
											operator: "==",
											rightExpression: {
												argumentTypes: null,
												hexValue: "74727565",
												id: 1670,
												isConstant: false,
												isLValue: false,
												isPure: true,
												kind: "bool",
												lValueRequested: false,
												nodeType: "Literal",
												src: "12420:4:2",
												subdenomination: null,
												typeDescriptions: {
													typeIdentifier: "t_bool",
													typeString: "bool"
												},
												value: "true"
											},
											src: "12375:49:2",
											typeDescriptions: {
												typeIdentifier: "t_bool",
												typeString: "bool"
											}
										},
										{
											argumentTypes: null,
											hexValue: "696420646f65736e2774206578697374",
											id: 1672,
											isConstant: false,
											isLValue: false,
											isPure: true,
											kind: "string",
											lValueRequested: false,
											nodeType: "Literal",
											src: "12426:18:2",
											subdenomination: null,
											typeDescriptions: {
												typeIdentifier: "t_stringliteral_db03d7ca062012de69c7826250fe821647bd15958d13d3f34e50a74943c7e2a1",
												typeString: "literal_string \"id doesn't exist\""
											},
											value: "id doesn't exist"
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bool",
												typeString: "bool"
											},
											{
												typeIdentifier: "t_stringliteral_db03d7ca062012de69c7826250fe821647bd15958d13d3f34e50a74943c7e2a1",
												typeString: "literal_string \"id doesn't exist\""
											}
										],
										id: 1664,
										name: "require",
										nodeType: "Identifier",
										overloadedDeclarations: [
											11011,
											11012
										],
										referencedDeclaration: 11012,
										src: "12367:7:2",
										typeDescriptions: {
											typeIdentifier: "t_function_require_pure$_t_bool_$_t_string_memory_ptr_$returns$__$",
											typeString: "function (bool,string memory) pure"
										}
									},
									id: 1673,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "12367:78:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 1674,
								nodeType: "ExpressionStatement",
								src: "12367:78:2"
							},
							{
								assignments: [
									1676,
									1678
								],
								declarations: [
									{
										constant: false,
										id: 1676,
										name: "permission",
										nodeType: "VariableDeclaration",
										scope: 1747,
										src: "12457:18:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										},
										typeName: {
											id: 1675,
											name: "uint256",
											nodeType: "ElementaryTypeName",
											src: "12457:7:2",
											typeDescriptions: {
												typeIdentifier: "t_uint256",
												typeString: "uint256"
											}
										},
										value: null,
										visibility: "internal"
									},
									{
										constant: false,
										id: 1678,
										name: "delegate",
										nodeType: "VariableDeclaration",
										scope: 1747,
										src: "12477:16:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_address",
											typeString: "address"
										},
										typeName: {
											id: 1677,
											name: "address",
											nodeType: "ElementaryTypeName",
											src: "12477:7:2",
											stateMutability: "nonpayable",
											typeDescriptions: {
												typeIdentifier: "t_address",
												typeString: "address"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 1682,
								initialValue: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1680,
											name: "tableKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1655,
											src: "12514:8:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										],
										id: 1679,
										name: "getTableMetadata",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 2003,
										src: "12497:16:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_view$_t_bytes32_$returns$_t_uint256_$_t_address_$",
											typeString: "function (bytes32) view returns (uint256,address)"
										}
									},
									id: 1681,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "12497:26:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$_t_uint256_$_t_address_$",
										typeString: "tuple(uint256,address)"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "12456:67:2"
							},
							{
								expression: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											commonType: {
												typeIdentifier: "t_uint256",
												typeString: "uint256"
											},
											id: 1686,
											isConstant: false,
											isLValue: false,
											isPure: false,
											lValueRequested: false,
											leftExpression: {
												argumentTypes: null,
												id: 1684,
												name: "permission",
												nodeType: "Identifier",
												overloadedDeclarations: [
												],
												referencedDeclaration: 1676,
												src: "12606:10:2",
												typeDescriptions: {
													typeIdentifier: "t_uint256",
													typeString: "uint256"
												}
											},
											nodeType: "BinaryOperation",
											operator: ">",
											rightExpression: {
												argumentTypes: null,
												hexValue: "30",
												id: 1685,
												isConstant: false,
												isLValue: false,
												isPure: true,
												kind: "number",
												lValueRequested: false,
												nodeType: "Literal",
												src: "12619:1:2",
												subdenomination: null,
												typeDescriptions: {
													typeIdentifier: "t_rational_0_by_1",
													typeString: "int_const 0"
												},
												value: "0"
											},
											src: "12606:14:2",
											typeDescriptions: {
												typeIdentifier: "t_bool",
												typeString: "bool"
											}
										},
										{
											argumentTypes: null,
											hexValue: "43616e6e6f742044454c4554452066726f6d2073797374656d207461626c65",
											id: 1687,
											isConstant: false,
											isLValue: false,
											isPure: true,
											kind: "string",
											lValueRequested: false,
											nodeType: "Literal",
											src: "12622:33:2",
											subdenomination: null,
											typeDescriptions: {
												typeIdentifier: "t_stringliteral_132c13b1ffd52b2761f3e4441db33850ce1f140ca1599ac0789f819d4b4791cd",
												typeString: "literal_string \"Cannot DELETE from system table\""
											},
											value: "Cannot DELETE from system table"
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bool",
												typeString: "bool"
											},
											{
												typeIdentifier: "t_stringliteral_132c13b1ffd52b2761f3e4441db33850ce1f140ca1599ac0789f819d4b4791cd",
												typeString: "literal_string \"Cannot DELETE from system table\""
											}
										],
										id: 1683,
										name: "require",
										nodeType: "Identifier",
										overloadedDeclarations: [
											11011,
											11012
										],
										referencedDeclaration: 11012,
										src: "12598:7:2",
										typeDescriptions: {
											typeIdentifier: "t_function_require_pure$_t_bool_$_t_string_memory_ptr_$returns$__$",
											typeString: "function (bool,string memory) pure"
										}
									},
									id: 1688,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "12598:58:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 1689,
								nodeType: "ExpressionStatement",
								src: "12598:58:2"
							},
							{
								expression: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											commonType: {
												typeIdentifier: "t_bool",
												typeString: "bool"
											},
											id: 1703,
											isConstant: false,
											isLValue: false,
											isPure: false,
											lValueRequested: false,
											leftExpression: {
												argumentTypes: null,
												commonType: {
													typeIdentifier: "t_bool",
													typeString: "bool"
												},
												id: 1698,
												isConstant: false,
												isLValue: false,
												isPure: false,
												lValueRequested: false,
												leftExpression: {
													argumentTypes: null,
													commonType: {
														typeIdentifier: "t_uint256",
														typeString: "uint256"
													},
													id: 1693,
													isConstant: false,
													isLValue: false,
													isPure: false,
													lValueRequested: false,
													leftExpression: {
														argumentTypes: null,
														id: 1691,
														name: "permission",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 1676,
														src: "12735:10:2",
														typeDescriptions: {
															typeIdentifier: "t_uint256",
															typeString: "uint256"
														}
													},
													nodeType: "BinaryOperation",
													operator: ">",
													rightExpression: {
														argumentTypes: null,
														hexValue: "31",
														id: 1692,
														isConstant: false,
														isLValue: false,
														isPure: true,
														kind: "number",
														lValueRequested: false,
														nodeType: "Literal",
														src: "12748:1:2",
														subdenomination: null,
														typeDescriptions: {
															typeIdentifier: "t_rational_1_by_1",
															typeString: "int_const 1"
														},
														value: "1"
													},
													src: "12735:14:2",
													typeDescriptions: {
														typeIdentifier: "t_bool",
														typeString: "bool"
													}
												},
												nodeType: "BinaryOperation",
												operator: "||",
												rightExpression: {
													argumentTypes: null,
													commonType: {
														typeIdentifier: "t_bool",
														typeString: "bool"
													},
													id: 1697,
													isConstant: false,
													isLValue: false,
													isPure: false,
													lValueRequested: false,
													leftExpression: {
														argumentTypes: null,
														"arguments": [
														],
														expression: {
															argumentTypes: [
															],
															id: 1694,
															name: "isOwner",
															nodeType: "Identifier",
															overloadedDeclarations: [
															],
															referencedDeclaration: 5016,
															src: "12753:7:2",
															typeDescriptions: {
																typeIdentifier: "t_function_internal_view$__$returns$_t_bool_$",
																typeString: "function () view returns (bool)"
															}
														},
														id: 1695,
														isConstant: false,
														isLValue: false,
														isPure: false,
														kind: "functionCall",
														lValueRequested: false,
														names: [
														],
														nodeType: "FunctionCall",
														src: "12753:9:2",
														typeDescriptions: {
															typeIdentifier: "t_bool",
															typeString: "bool"
														}
													},
													nodeType: "BinaryOperation",
													operator: "==",
													rightExpression: {
														argumentTypes: null,
														hexValue: "74727565",
														id: 1696,
														isConstant: false,
														isLValue: false,
														isPure: true,
														kind: "bool",
														lValueRequested: false,
														nodeType: "Literal",
														src: "12766:4:2",
														subdenomination: null,
														typeDescriptions: {
															typeIdentifier: "t_bool",
															typeString: "bool"
														},
														value: "true"
													},
													src: "12753:17:2",
													typeDescriptions: {
														typeIdentifier: "t_bool",
														typeString: "bool"
													}
												},
												src: "12735:35:2",
												typeDescriptions: {
													typeIdentifier: "t_bool",
													typeString: "bool"
												}
											},
											nodeType: "BinaryOperation",
											operator: "||",
											rightExpression: {
												argumentTypes: null,
												commonType: {
													typeIdentifier: "t_address",
													typeString: "address"
												},
												id: 1702,
												isConstant: false,
												isLValue: false,
												isPure: false,
												lValueRequested: false,
												leftExpression: {
													argumentTypes: null,
													id: 1699,
													name: "delegate",
													nodeType: "Identifier",
													overloadedDeclarations: [
													],
													referencedDeclaration: 1678,
													src: "12774:8:2",
													typeDescriptions: {
														typeIdentifier: "t_address",
														typeString: "address"
													}
												},
												nodeType: "BinaryOperation",
												operator: "==",
												rightExpression: {
													argumentTypes: null,
													"arguments": [
													],
													expression: {
														argumentTypes: [
														],
														id: 1700,
														name: "_msgSender",
														nodeType: "Identifier",
														overloadedDeclarations: [
															3607
														],
														referencedDeclaration: 3607,
														src: "12786:10:2",
														typeDescriptions: {
															typeIdentifier: "t_function_internal_view$__$returns$_t_address_$",
															typeString: "function () view returns (address)"
														}
													},
													id: 1701,
													isConstant: false,
													isLValue: false,
													isPure: false,
													kind: "functionCall",
													lValueRequested: false,
													names: [
													],
													nodeType: "FunctionCall",
													src: "12786:12:2",
													typeDescriptions: {
														typeIdentifier: "t_address",
														typeString: "address"
													}
												},
												src: "12774:24:2",
												typeDescriptions: {
													typeIdentifier: "t_bool",
													typeString: "bool"
												}
											},
											src: "12735:63:2",
											typeDescriptions: {
												typeIdentifier: "t_bool",
												typeString: "bool"
											}
										},
										{
											argumentTypes: null,
											hexValue: "4f6e6c79206f776e65722f64656c65676174652063616e2044454c4554452066726f6d2074686973207461626c65",
											id: 1704,
											isConstant: false,
											isLValue: false,
											isPure: true,
											kind: "string",
											lValueRequested: false,
											nodeType: "Literal",
											src: "12800:48:2",
											subdenomination: null,
											typeDescriptions: {
												typeIdentifier: "t_stringliteral_c33372ce630f0cab4512ab6a1cf4a2edfc443bf5b1df150e7f701bd1549103a6",
												typeString: "literal_string \"Only owner/delegate can DELETE from this table\""
											},
											value: "Only owner/delegate can DELETE from this table"
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bool",
												typeString: "bool"
											},
											{
												typeIdentifier: "t_stringliteral_c33372ce630f0cab4512ab6a1cf4a2edfc443bf5b1df150e7f701bd1549103a6",
												typeString: "literal_string \"Only owner/delegate can DELETE from this table\""
											}
										],
										id: 1690,
										name: "require",
										nodeType: "Identifier",
										overloadedDeclarations: [
											11011,
											11012
										],
										referencedDeclaration: 11012,
										src: "12727:7:2",
										typeDescriptions: {
											typeIdentifier: "t_function_require_pure$_t_bool_$_t_string_memory_ptr_$returns$__$",
											typeString: "function (bool,string memory) pure"
										}
									},
									id: 1705,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "12727:122:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 1706,
								nodeType: "ExpressionStatement",
								src: "12727:122:2"
							},
							{
								condition: {
									argumentTypes: null,
									commonType: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									},
									id: 1709,
									isConstant: false,
									isLValue: false,
									isPure: false,
									lValueRequested: false,
									leftExpression: {
										argumentTypes: null,
										id: 1707,
										name: "permission",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 1676,
										src: "13023:10:2",
										typeDescriptions: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										}
									},
									nodeType: "BinaryOperation",
									operator: ">=",
									rightExpression: {
										argumentTypes: null,
										hexValue: "32",
										id: 1708,
										isConstant: false,
										isLValue: false,
										isPure: true,
										kind: "number",
										lValueRequested: false,
										nodeType: "Literal",
										src: "13037:1:2",
										subdenomination: null,
										typeDescriptions: {
											typeIdentifier: "t_rational_2_by_1",
											typeString: "int_const 2"
										},
										value: "2"
									},
									src: "13023:15:2",
									typeDescriptions: {
										typeIdentifier: "t_bool",
										typeString: "bool"
									}
								},
								falseBody: null,
								id: 1746,
								nodeType: "IfStatement",
								src: "13019:457:2",
								trueBody: {
									id: 1745,
									nodeType: "Block",
									src: "13040:436:2",
									statements: [
										{
											condition: {
												argumentTypes: null,
												commonType: {
													typeIdentifier: "t_bool",
													typeString: "bool"
												},
												id: 1716,
												isConstant: false,
												isLValue: false,
												isPure: false,
												lValueRequested: false,
												leftExpression: {
													argumentTypes: null,
													"arguments": [
													],
													expression: {
														argumentTypes: [
														],
														id: 1710,
														name: "isOwner",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 5016,
														src: "13058:7:2",
														typeDescriptions: {
															typeIdentifier: "t_function_internal_view$__$returns$_t_bool_$",
															typeString: "function () view returns (bool)"
														}
													},
													id: 1711,
													isConstant: false,
													isLValue: false,
													isPure: false,
													kind: "functionCall",
													lValueRequested: false,
													names: [
													],
													nodeType: "FunctionCall",
													src: "13058:9:2",
													typeDescriptions: {
														typeIdentifier: "t_bool",
														typeString: "bool"
													}
												},
												nodeType: "BinaryOperation",
												operator: "||",
												rightExpression: {
													argumentTypes: null,
													commonType: {
														typeIdentifier: "t_address",
														typeString: "address"
													},
													id: 1715,
													isConstant: false,
													isLValue: false,
													isPure: false,
													lValueRequested: false,
													leftExpression: {
														argumentTypes: null,
														id: 1712,
														name: "delegate",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 1678,
														src: "13071:8:2",
														typeDescriptions: {
															typeIdentifier: "t_address",
															typeString: "address"
														}
													},
													nodeType: "BinaryOperation",
													operator: "==",
													rightExpression: {
														argumentTypes: null,
														"arguments": [
														],
														expression: {
															argumentTypes: [
															],
															id: 1713,
															name: "_msgSender",
															nodeType: "Identifier",
															overloadedDeclarations: [
																3607
															],
															referencedDeclaration: 3607,
															src: "13083:10:2",
															typeDescriptions: {
																typeIdentifier: "t_function_internal_view$__$returns$_t_address_$",
																typeString: "function () view returns (address)"
															}
														},
														id: 1714,
														isConstant: false,
														isLValue: false,
														isPure: false,
														kind: "functionCall",
														lValueRequested: false,
														names: [
														],
														nodeType: "FunctionCall",
														src: "13083:12:2",
														typeDescriptions: {
															typeIdentifier: "t_address",
															typeString: "address"
														}
													},
													src: "13071:24:2",
													typeDescriptions: {
														typeIdentifier: "t_bool",
														typeString: "bool"
													}
												},
												src: "13058:37:2",
												typeDescriptions: {
													typeIdentifier: "t_bool",
													typeString: "bool"
												}
											},
											falseBody: {
												id: 1743,
												nodeType: "Block",
												src: "13141:325:2",
												statements: [
													{
														assignments: [
															1719
														],
														declarations: [
															{
																constant: false,
																id: 1719,
																name: "rowMetaData",
																nodeType: "VariableDeclaration",
																scope: 1743,
																src: "13244:19:2",
																stateVariable: false,
																storageLocation: "default",
																typeDescriptions: {
																	typeIdentifier: "t_bytes32",
																	typeString: "bytes32"
																},
																typeName: {
																	id: 1718,
																	name: "bytes32",
																	nodeType: "ElementaryTypeName",
																	src: "13244:7:2",
																	typeDescriptions: {
																		typeIdentifier: "t_bytes32",
																		typeString: "bytes32"
																	}
																},
																value: null,
																visibility: "internal"
															}
														],
														id: 1724,
														initialValue: {
															argumentTypes: null,
															"arguments": [
																{
																	argumentTypes: null,
																	id: 1722,
																	name: "idTableKey",
																	nodeType: "Identifier",
																	overloadedDeclarations: [
																	],
																	referencedDeclaration: 1657,
																	src: "13292:10:2",
																	typeDescriptions: {
																		typeIdentifier: "t_bytes32",
																		typeString: "bytes32"
																	}
																}
															],
															expression: {
																argumentTypes: [
																	{
																		typeIdentifier: "t_bytes32",
																		typeString: "bytes32"
																	}
																],
																expression: {
																	argumentTypes: null,
																	id: 1720,
																	name: "database",
																	nodeType: "Identifier",
																	overloadedDeclarations: [
																	],
																	referencedDeclaration: 997,
																	src: "13266:8:2",
																	typeDescriptions: {
																		typeIdentifier: "t_struct$_PolymorphicDictionary_$7490_storage",
																		typeString: "struct PolymorphicDictionaryLib.PolymorphicDictionary storage ref"
																	}
																},
																id: 1721,
																isConstant: false,
																isLValue: true,
																isPure: false,
																lValueRequested: false,
																memberName: "getBytes32ForKey",
																nodeType: "MemberAccess",
																referencedDeclaration: 7971,
																src: "13266:25:2",
																typeDescriptions: {
																	typeIdentifier: "t_function_internal_view$_t_struct$_PolymorphicDictionary_$7490_storage_ptr_$_t_bytes32_$returns$_t_bytes32_$bound_to$_t_struct$_PolymorphicDictionary_$7490_storage_ptr_$",
																	typeString: "function (struct PolymorphicDictionaryLib.PolymorphicDictionary storage pointer,bytes32) view returns (bytes32)"
																}
															},
															id: 1723,
															isConstant: false,
															isLValue: false,
															isPure: false,
															kind: "functionCall",
															lValueRequested: false,
															names: [
															],
															nodeType: "FunctionCall",
															src: "13266:37:2",
															typeDescriptions: {
																typeIdentifier: "t_bytes32",
																typeString: "bytes32"
															}
														},
														nodeType: "VariableDeclarationStatement",
														src: "13244:59:2"
													},
													{
														assignments: [
															1726
														],
														declarations: [
															{
																constant: false,
																id: 1726,
																name: "rowOwner",
																nodeType: "VariableDeclaration",
																scope: 1743,
																src: "13321:16:2",
																stateVariable: false,
																storageLocation: "default",
																typeDescriptions: {
																	typeIdentifier: "t_address",
																	typeString: "address"
																},
																typeName: {
																	id: 1725,
																	name: "address",
																	nodeType: "ElementaryTypeName",
																	src: "13321:7:2",
																	stateMutability: "nonpayable",
																	typeDescriptions: {
																		typeIdentifier: "t_address",
																		typeString: "address"
																	}
																},
																value: null,
																visibility: "internal"
															}
														],
														id: 1734,
														initialValue: {
															argumentTypes: null,
															"arguments": [
																{
																	argumentTypes: null,
																	commonType: {
																		typeIdentifier: "t_uint256",
																		typeString: "uint256"
																	},
																	id: 1732,
																	isConstant: false,
																	isLValue: false,
																	isPure: false,
																	lValueRequested: false,
																	leftExpression: {
																		argumentTypes: null,
																		"arguments": [
																			{
																				argumentTypes: null,
																				id: 1729,
																				name: "rowMetaData",
																				nodeType: "Identifier",
																				overloadedDeclarations: [
																				],
																				referencedDeclaration: 1719,
																				src: "13356:11:2",
																				typeDescriptions: {
																					typeIdentifier: "t_bytes32",
																					typeString: "bytes32"
																				}
																			}
																		],
																		expression: {
																			argumentTypes: [
																				{
																					typeIdentifier: "t_bytes32",
																					typeString: "bytes32"
																				}
																			],
																			id: 1728,
																			isConstant: false,
																			isLValue: false,
																			isPure: true,
																			lValueRequested: false,
																			nodeType: "ElementaryTypeNameExpression",
																			src: "13348:7:2",
																			typeDescriptions: {
																				typeIdentifier: "t_type$_t_uint256_$",
																				typeString: "type(uint256)"
																			},
																			typeName: "uint256"
																		},
																		id: 1730,
																		isConstant: false,
																		isLValue: false,
																		isPure: false,
																		kind: "typeConversion",
																		lValueRequested: false,
																		names: [
																		],
																		nodeType: "FunctionCall",
																		src: "13348:20:2",
																		typeDescriptions: {
																			typeIdentifier: "t_uint256",
																			typeString: "uint256"
																		}
																	},
																	nodeType: "BinaryOperation",
																	operator: ">>",
																	rightExpression: {
																		argumentTypes: null,
																		hexValue: "3332",
																		id: 1731,
																		isConstant: false,
																		isLValue: false,
																		isPure: true,
																		kind: "number",
																		lValueRequested: false,
																		nodeType: "Literal",
																		src: "13370:2:2",
																		subdenomination: null,
																		typeDescriptions: {
																			typeIdentifier: "t_rational_32_by_1",
																			typeString: "int_const 32"
																		},
																		value: "32"
																	},
																	src: "13348:24:2",
																	typeDescriptions: {
																		typeIdentifier: "t_uint256",
																		typeString: "uint256"
																	}
																}
															],
															expression: {
																argumentTypes: [
																	{
																		typeIdentifier: "t_uint256",
																		typeString: "uint256"
																	}
																],
																id: 1727,
																isConstant: false,
																isLValue: false,
																isPure: true,
																lValueRequested: false,
																nodeType: "ElementaryTypeNameExpression",
																src: "13340:7:2",
																typeDescriptions: {
																	typeIdentifier: "t_type$_t_address_$",
																	typeString: "type(address)"
																},
																typeName: "address"
															},
															id: 1733,
															isConstant: false,
															isLValue: false,
															isPure: false,
															kind: "typeConversion",
															lValueRequested: false,
															names: [
															],
															nodeType: "FunctionCall",
															src: "13340:33:2",
															typeDescriptions: {
																typeIdentifier: "t_address_payable",
																typeString: "address payable"
															}
														},
														nodeType: "VariableDeclarationStatement",
														src: "13321:52:2"
													},
													{
														expression: {
															argumentTypes: null,
															"arguments": [
																{
																	argumentTypes: null,
																	commonType: {
																		typeIdentifier: "t_address",
																		typeString: "address"
																	},
																	id: 1739,
																	isConstant: false,
																	isLValue: false,
																	isPure: false,
																	lValueRequested: false,
																	leftExpression: {
																		argumentTypes: null,
																		id: 1736,
																		name: "rowOwner",
																		nodeType: "Identifier",
																		overloadedDeclarations: [
																		],
																		referencedDeclaration: 1726,
																		src: "13399:8:2",
																		typeDescriptions: {
																			typeIdentifier: "t_address",
																			typeString: "address"
																		}
																	},
																	nodeType: "BinaryOperation",
																	operator: "==",
																	rightExpression: {
																		argumentTypes: null,
																		"arguments": [
																		],
																		expression: {
																			argumentTypes: [
																			],
																			id: 1737,
																			name: "_msgSender",
																			nodeType: "Identifier",
																			overloadedDeclarations: [
																				3607
																			],
																			referencedDeclaration: 3607,
																			src: "13411:10:2",
																			typeDescriptions: {
																				typeIdentifier: "t_function_internal_view$__$returns$_t_address_$",
																				typeString: "function () view returns (address)"
																			}
																		},
																		id: 1738,
																		isConstant: false,
																		isLValue: false,
																		isPure: false,
																		kind: "functionCall",
																		lValueRequested: false,
																		names: [
																		],
																		nodeType: "FunctionCall",
																		src: "13411:12:2",
																		typeDescriptions: {
																			typeIdentifier: "t_address",
																			typeString: "address"
																		}
																	},
																	src: "13399:24:2",
																	typeDescriptions: {
																		typeIdentifier: "t_bool",
																		typeString: "bool"
																	}
																},
																{
																	argumentTypes: null,
																	hexValue: "53656e646572206e6f74206f776e6572206f6620726f77",
																	id: 1740,
																	isConstant: false,
																	isLValue: false,
																	isPure: true,
																	kind: "string",
																	lValueRequested: false,
																	nodeType: "Literal",
																	src: "13425:25:2",
																	subdenomination: null,
																	typeDescriptions: {
																		typeIdentifier: "t_stringliteral_fa8a74fd1acb40aac2f8444f4811d8b38e0f8d0e7daab82b9b6c362343d2fb4a",
																		typeString: "literal_string \"Sender not owner of row\""
																	},
																	value: "Sender not owner of row"
																}
															],
															expression: {
																argumentTypes: [
																	{
																		typeIdentifier: "t_bool",
																		typeString: "bool"
																	},
																	{
																		typeIdentifier: "t_stringliteral_fa8a74fd1acb40aac2f8444f4811d8b38e0f8d0e7daab82b9b6c362343d2fb4a",
																		typeString: "literal_string \"Sender not owner of row\""
																	}
																],
																id: 1735,
																name: "require",
																nodeType: "Identifier",
																overloadedDeclarations: [
																	11011,
																	11012
																],
																referencedDeclaration: 11012,
																src: "13391:7:2",
																typeDescriptions: {
																	typeIdentifier: "t_function_require_pure$_t_bool_$_t_string_memory_ptr_$returns$__$",
																	typeString: "function (bool,string memory) pure"
																}
															},
															id: 1741,
															isConstant: false,
															isLValue: false,
															isPure: false,
															kind: "functionCall",
															lValueRequested: false,
															names: [
															],
															nodeType: "FunctionCall",
															src: "13391:60:2",
															typeDescriptions: {
																typeIdentifier: "t_tuple$__$",
																typeString: "tuple()"
															}
														},
														id: 1742,
														nodeType: "ExpressionStatement",
														src: "13391:60:2"
													}
												]
											},
											id: 1744,
											nodeType: "IfStatement",
											src: "13054:412:2",
											trueBody: {
												id: 1717,
												nodeType: "Block",
												src: "13096:39:2",
												statements: [
												]
											}
										}
									]
								}
							}
						]
					},
					documentation: null,
					id: 1748,
					implemented: true,
					kind: "function",
					modifiers: [
					],
					name: "deleteCheck",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 1662,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1655,
								name: "tableKey",
								nodeType: "VariableDeclaration",
								scope: 1748,
								src: "12282:16:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1654,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "12282:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							},
							{
								constant: false,
								id: 1657,
								name: "idTableKey",
								nodeType: "VariableDeclaration",
								scope: 1748,
								src: "12300:18:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1656,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "12300:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							},
							{
								constant: false,
								id: 1659,
								name: "idKey",
								nodeType: "VariableDeclaration",
								scope: 1748,
								src: "12320:13:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1658,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "12320:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							},
							{
								constant: false,
								id: 1661,
								name: "id",
								nodeType: "VariableDeclaration",
								scope: 1748,
								src: "12335:10:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1660,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "12335:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "12281:65:2"
					},
					returnParameters: {
						id: 1663,
						nodeType: "ParameterList",
						parameters: [
						],
						src: "12356:0:2"
					},
					scope: 2289,
					src: "12261:1221:2",
					stateMutability: "nonpayable",
					superFunction: null,
					visibility: "internal"
				},
				{
					body: {
						id: 1797,
						nodeType: "Block",
						src: "13781:1063:2",
						statements: [
							{
								assignments: [
									1760
								],
								declarations: [
									{
										constant: false,
										id: 1760,
										name: "idTableKey",
										nodeType: "VariableDeclaration",
										scope: 1797,
										src: "13792:18:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_bytes32",
											typeString: "bytes32"
										},
										typeName: {
											id: 1759,
											name: "bytes32",
											nodeType: "ElementaryTypeName",
											src: "13792:7:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 1765,
								initialValue: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1762,
											name: "idKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1752,
											src: "13822:5:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										{
											argumentTypes: null,
											id: 1763,
											name: "tableKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1750,
											src: "13829:8:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											},
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										],
										id: 1761,
										name: "namehash",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 1960,
										src: "13813:8:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_pure$_t_bytes32_$_t_bytes32_$returns$_t_bytes32_$",
											typeString: "function (bytes32,bytes32) pure returns (bytes32)"
										}
									},
									id: 1764,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "13813:25:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "13792:46:2"
							},
							{
								assignments: [
									1767
								],
								declarations: [
									{
										constant: false,
										id: 1767,
										name: "fieldIdTableKey",
										nodeType: "VariableDeclaration",
										scope: 1797,
										src: "13848:23:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_bytes32",
											typeString: "bytes32"
										},
										typeName: {
											id: 1766,
											name: "bytes32",
											nodeType: "ElementaryTypeName",
											src: "13848:7:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 1772,
								initialValue: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1769,
											name: "fieldKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1754,
											src: "13883:8:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										{
											argumentTypes: null,
											id: 1770,
											name: "idTableKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1760,
											src: "13893:10:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											},
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										],
										id: 1768,
										name: "namehash",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 1960,
										src: "13874:8:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_pure$_t_bytes32_$_t_bytes32_$returns$_t_bytes32_$",
											typeString: "function (bytes32,bytes32) pure returns (bytes32)"
										}
									},
									id: 1771,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "13874:30:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "13848:56:2"
							},
							{
								expression: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1774,
											name: "tableKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1750,
											src: "13927:8:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										{
											argumentTypes: null,
											id: 1775,
											name: "idTableKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1760,
											src: "13937:10:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										{
											argumentTypes: null,
											id: 1776,
											name: "idKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1752,
											src: "13949:5:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										{
											argumentTypes: null,
											id: 1777,
											name: "id",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1756,
											src: "13956:2:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											},
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											},
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											},
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										],
										id: 1773,
										name: "deleteCheck",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 1748,
										src: "13915:11:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_nonpayable$_t_bytes32_$_t_bytes32_$_t_bytes32_$_t_bytes32_$returns$__$",
											typeString: "function (bytes32,bytes32,bytes32,bytes32)"
										}
									},
									id: 1778,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "13915:44:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 1779,
								nodeType: "ExpressionStatement",
								src: "13915:44:2"
							},
							{
								expression: {
									argumentTypes: null,
									"arguments": [
									],
									expression: {
										argumentTypes: [
										],
										id: 1780,
										name: "increaseGsnCounter",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 2128,
										src: "13999:18:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_nonpayable$__$returns$__$",
											typeString: "function ()"
										}
									},
									id: 1781,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "13999:20:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 1782,
								nodeType: "ExpressionStatement",
								src: "13999:20:2"
							},
							{
								assignments: [
									1784
								],
								declarations: [
									{
										constant: false,
										id: 1784,
										name: "removed",
										nodeType: "VariableDeclaration",
										scope: 1797,
										src: "14056:12:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_bool",
											typeString: "bool"
										},
										typeName: {
											id: 1783,
											name: "bool",
											nodeType: "ElementaryTypeName",
											src: "14056:4:2",
											typeDescriptions: {
												typeIdentifier: "t_bool",
												typeString: "bool"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 1789,
								initialValue: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1787,
											name: "fieldIdTableKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1767,
											src: "14090:15:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										],
										expression: {
											argumentTypes: null,
											id: 1785,
											name: "database",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 997,
											src: "14071:8:2",
											typeDescriptions: {
												typeIdentifier: "t_struct$_PolymorphicDictionary_$7490_storage",
												typeString: "struct PolymorphicDictionaryLib.PolymorphicDictionary storage ref"
											}
										},
										id: 1786,
										isConstant: false,
										isLValue: true,
										isPure: false,
										lValueRequested: false,
										memberName: "removeKey",
										nodeType: "MemberAccess",
										referencedDeclaration: 8947,
										src: "14071:18:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_nonpayable$_t_struct$_PolymorphicDictionary_$7490_storage_ptr_$_t_bytes32_$returns$_t_bool_$bound_to$_t_struct$_PolymorphicDictionary_$7490_storage_ptr_$",
											typeString: "function (struct PolymorphicDictionaryLib.PolymorphicDictionary storage pointer,bytes32) returns (bool)"
										}
									},
									id: 1788,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "14071:35:2",
									typeDescriptions: {
										typeIdentifier: "t_bool",
										typeString: "bool"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "14056:50:2"
							},
							{
								expression: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											commonType: {
												typeIdentifier: "t_bool",
												typeString: "bool"
											},
											id: 1793,
											isConstant: false,
											isLValue: false,
											isPure: false,
											lValueRequested: false,
											leftExpression: {
												argumentTypes: null,
												id: 1791,
												name: "removed",
												nodeType: "Identifier",
												overloadedDeclarations: [
												],
												referencedDeclaration: 1784,
												src: "14125:7:2",
												typeDescriptions: {
													typeIdentifier: "t_bool",
													typeString: "bool"
												}
											},
											nodeType: "BinaryOperation",
											operator: "==",
											rightExpression: {
												argumentTypes: null,
												hexValue: "74727565",
												id: 1792,
												isConstant: false,
												isLValue: false,
												isPure: true,
												kind: "bool",
												lValueRequested: false,
												nodeType: "Literal",
												src: "14136:4:2",
												subdenomination: null,
												typeDescriptions: {
													typeIdentifier: "t_bool",
													typeString: "bool"
												},
												value: "true"
											},
											src: "14125:15:2",
											typeDescriptions: {
												typeIdentifier: "t_bool",
												typeString: "bool"
											}
										},
										{
											argumentTypes: null,
											hexValue: "6572726f722072656d6f76696e67206b6579",
											id: 1794,
											isConstant: false,
											isLValue: false,
											isPure: true,
											kind: "string",
											lValueRequested: false,
											nodeType: "Literal",
											src: "14142:20:2",
											subdenomination: null,
											typeDescriptions: {
												typeIdentifier: "t_stringliteral_9802ffb053ccae9d16816deee5376dcb8b1c3e7f6a19281a861295bb0e1ac720",
												typeString: "literal_string \"error removing key\""
											},
											value: "error removing key"
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bool",
												typeString: "bool"
											},
											{
												typeIdentifier: "t_stringliteral_9802ffb053ccae9d16816deee5376dcb8b1c3e7f6a19281a861295bb0e1ac720",
												typeString: "literal_string \"error removing key\""
											}
										],
										id: 1790,
										name: "require",
										nodeType: "Identifier",
										overloadedDeclarations: [
											11011,
											11012
										],
										referencedDeclaration: 11012,
										src: "14117:7:2",
										typeDescriptions: {
											typeIdentifier: "t_function_require_pure$_t_bool_$_t_string_memory_ptr_$returns$__$",
											typeString: "function (bool,string memory) pure"
										}
									},
									id: 1795,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "14117:46:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 1796,
								nodeType: "ExpressionStatement",
								src: "14117:46:2"
							}
						]
					},
					documentation: "@dev TODO: add modifier checks based on update\n     * TODO: this needs to properly remove the row when there are multiple ids\n     ",
					id: 1798,
					implemented: true,
					kind: "function",
					modifiers: [
					],
					name: "deleteVal",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 1757,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1750,
								name: "tableKey",
								nodeType: "VariableDeclaration",
								scope: 1798,
								src: "13680:16:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1749,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "13680:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							},
							{
								constant: false,
								id: 1752,
								name: "idKey",
								nodeType: "VariableDeclaration",
								scope: 1798,
								src: "13706:13:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1751,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "13706:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							},
							{
								constant: false,
								id: 1754,
								name: "fieldKey",
								nodeType: "VariableDeclaration",
								scope: 1798,
								src: "13729:16:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1753,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "13729:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							},
							{
								constant: false,
								id: 1756,
								name: "id",
								nodeType: "VariableDeclaration",
								scope: 1798,
								src: "13756:10:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1755,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "13756:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "13669:104:2"
					},
					returnParameters: {
						id: 1758,
						nodeType: "ParameterList",
						parameters: [
						],
						src: "13781:0:2"
					},
					scope: 2289,
					src: "13651:1193:2",
					stateMutability: "nonpayable",
					superFunction: null,
					visibility: "public"
				},
				{
					body: {
						id: 1831,
						nodeType: "Block",
						src: "15226:254:2",
						statements: [
							{
								assignments: [
									1808
								],
								declarations: [
									{
										constant: false,
										id: 1808,
										name: "idTableKey",
										nodeType: "VariableDeclaration",
										scope: 1831,
										src: "15237:18:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_bytes32",
											typeString: "bytes32"
										},
										typeName: {
											id: 1807,
											name: "bytes32",
											nodeType: "ElementaryTypeName",
											src: "15237:7:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 1813,
								initialValue: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1810,
											name: "idKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1802,
											src: "15267:5:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										{
											argumentTypes: null,
											id: 1811,
											name: "tableKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1800,
											src: "15274:8:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											},
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										],
										id: 1809,
										name: "namehash",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 1960,
										src: "15258:8:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_pure$_t_bytes32_$_t_bytes32_$returns$_t_bytes32_$",
											typeString: "function (bytes32,bytes32) pure returns (bytes32)"
										}
									},
									id: 1812,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "15258:25:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "15237:46:2"
							},
							{
								expression: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1815,
											name: "tableKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1800,
											src: "15306:8:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										{
											argumentTypes: null,
											id: 1816,
											name: "idTableKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1808,
											src: "15316:10:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										{
											argumentTypes: null,
											id: 1817,
											name: "idKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1802,
											src: "15328:5:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										{
											argumentTypes: null,
											id: 1818,
											name: "id",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1804,
											src: "15335:2:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											},
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											},
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											},
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										],
										id: 1814,
										name: "deleteCheck",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 1748,
										src: "15294:11:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_nonpayable$_t_bytes32_$_t_bytes32_$_t_bytes32_$_t_bytes32_$returns$__$",
											typeString: "function (bytes32,bytes32,bytes32,bytes32)"
										}
									},
									id: 1819,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "15294:44:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 1820,
								nodeType: "ExpressionStatement",
								src: "15294:44:2"
							},
							{
								expression: {
									argumentTypes: null,
									"arguments": [
									],
									expression: {
										argumentTypes: [
										],
										id: 1821,
										name: "increaseGsnCounter",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 2128,
										src: "15378:18:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_nonpayable$__$returns$__$",
											typeString: "function ()"
										}
									},
									id: 1822,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "15378:20:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 1823,
								nodeType: "ExpressionStatement",
								src: "15378:20:2"
							},
							{
								expression: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1827,
											name: "tableKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1800,
											src: "15460:8:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										{
											argumentTypes: null,
											id: 1828,
											name: "id",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1804,
											src: "15470:2:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											},
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										],
										expression: {
											argumentTypes: null,
											id: 1824,
											name: "tableId",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 986,
											src: "15434:7:2",
											typeDescriptions: {
												typeIdentifier: "t_struct$_Bytes32SetDictionary_$6250_storage",
												typeString: "struct Bytes32SetDictionaryLib.Bytes32SetDictionary storage ref"
											}
										},
										id: 1826,
										isConstant: false,
										isLValue: true,
										isPure: false,
										lValueRequested: false,
										memberName: "removeValueForKey",
										nodeType: "MemberAccess",
										referencedDeclaration: 6408,
										src: "15434:25:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_nonpayable$_t_struct$_Bytes32SetDictionary_$6250_storage_ptr_$_t_bytes32_$_t_bytes32_$returns$_t_bool_$bound_to$_t_struct$_Bytes32SetDictionary_$6250_storage_ptr_$",
											typeString: "function (struct Bytes32SetDictionaryLib.Bytes32SetDictionary storage pointer,bytes32,bytes32) returns (bool)"
										}
									},
									id: 1829,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "15434:39:2",
									typeDescriptions: {
										typeIdentifier: "t_bool",
										typeString: "bool"
									}
								},
								id: 1830,
								nodeType: "ExpressionStatement",
								src: "15434:39:2"
							}
						]
					},
					documentation: null,
					id: 1832,
					implemented: true,
					kind: "function",
					modifiers: [
					],
					name: "deleteRow",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 1805,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1800,
								name: "tableKey",
								nodeType: "VariableDeclaration",
								scope: 1832,
								src: "15152:16:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1799,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "15152:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							},
							{
								constant: false,
								id: 1802,
								name: "idKey",
								nodeType: "VariableDeclaration",
								scope: 1832,
								src: "15178:13:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1801,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "15178:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							},
							{
								constant: false,
								id: 1804,
								name: "id",
								nodeType: "VariableDeclaration",
								scope: 1832,
								src: "15201:10:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1803,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "15201:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "15141:77:2"
					},
					returnParameters: {
						id: 1806,
						nodeType: "ParameterList",
						parameters: [
						],
						src: "15226:0:2"
					},
					scope: 2289,
					src: "15123:357:2",
					stateMutability: "nonpayable",
					superFunction: null,
					visibility: "public"
				},
				{
					body: {
						id: 1844,
						nodeType: "Block",
						src: "16869:49:2",
						statements: [
							{
								expression: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1841,
											name: "key",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1834,
											src: "16907:3:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										],
										expression: {
											argumentTypes: null,
											id: 1839,
											name: "database",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 997,
											src: "16886:8:2",
											typeDescriptions: {
												typeIdentifier: "t_struct$_PolymorphicDictionary_$7490_storage",
												typeString: "struct PolymorphicDictionaryLib.PolymorphicDictionary storage ref"
											}
										},
										id: 1840,
										isConstant: false,
										isLValue: true,
										isPure: false,
										lValueRequested: false,
										memberName: "containsKey",
										nodeType: "MemberAccess",
										referencedDeclaration: 7798,
										src: "16886:20:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_view$_t_struct$_PolymorphicDictionary_$7490_storage_ptr_$_t_bytes32_$returns$_t_bool_$bound_to$_t_struct$_PolymorphicDictionary_$7490_storage_ptr_$",
											typeString: "function (struct PolymorphicDictionaryLib.PolymorphicDictionary storage pointer,bytes32) view returns (bool)"
										}
									},
									id: 1842,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "16886:25:2",
									typeDescriptions: {
										typeIdentifier: "t_bool",
										typeString: "bool"
									}
								},
								functionReturnParameters: 1838,
								id: 1843,
								nodeType: "Return",
								src: "16879:32:2"
							}
						]
					},
					documentation: "@dev Table actual insert call, NOTE this doesn't work on testnet currently due to a stack size issue,\n     but it can work with a paid transaction I guess",
					id: 1845,
					implemented: true,
					kind: "function",
					modifiers: [
					],
					name: "checkDataKey",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 1835,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1834,
								name: "key",
								nodeType: "VariableDeclaration",
								scope: 1845,
								src: "16827:11:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1833,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "16827:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "16826:13:2"
					},
					returnParameters: {
						id: 1838,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1837,
								name: "",
								nodeType: "VariableDeclaration",
								scope: 1845,
								src: "16863:4:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bool",
									typeString: "bool"
								},
								typeName: {
									id: 1836,
									name: "bool",
									nodeType: "ElementaryTypeName",
									src: "16863:4:2",
									typeDescriptions: {
										typeIdentifier: "t_bool",
										typeString: "bool"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "16862:6:2"
					},
					scope: 2289,
					src: "16805:113:2",
					stateMutability: "view",
					superFunction: null,
					visibility: "external"
				},
				{
					body: {
						id: 1868,
						nodeType: "Block",
						src: "17128:182:2",
						statements: [
							{
								condition: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1854,
											name: "fieldIdTableKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1847,
											src: "17164:15:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										],
										expression: {
											argumentTypes: null,
											id: 1852,
											name: "database",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 997,
											src: "17143:8:2",
											typeDescriptions: {
												typeIdentifier: "t_struct$_PolymorphicDictionary_$7490_storage",
												typeString: "struct PolymorphicDictionaryLib.PolymorphicDictionary storage ref"
											}
										},
										id: 1853,
										isConstant: false,
										isLValue: true,
										isPure: false,
										lValueRequested: false,
										memberName: "containsKey",
										nodeType: "MemberAccess",
										referencedDeclaration: 7798,
										src: "17143:20:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_view$_t_struct$_PolymorphicDictionary_$7490_storage_ptr_$_t_bytes32_$returns$_t_bool_$bound_to$_t_struct$_PolymorphicDictionary_$7490_storage_ptr_$",
											typeString: "function (struct PolymorphicDictionaryLib.PolymorphicDictionary storage pointer,bytes32) view returns (bool)"
										}
									},
									id: 1855,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "17143:37:2",
									typeDescriptions: {
										typeIdentifier: "t_bool",
										typeString: "bool"
									}
								},
								falseBody: {
									id: 1866,
									nodeType: "Block",
									src: "17262:42:2",
									statements: [
										{
											expression: {
												argumentTypes: null,
												"arguments": [
													{
														argumentTypes: null,
														hexValue: "30",
														id: 1863,
														isConstant: false,
														isLValue: false,
														isPure: true,
														kind: "number",
														lValueRequested: false,
														nodeType: "Literal",
														src: "17291:1:2",
														subdenomination: null,
														typeDescriptions: {
															typeIdentifier: "t_rational_0_by_1",
															typeString: "int_const 0"
														},
														value: "0"
													}
												],
												expression: {
													argumentTypes: [
														{
															typeIdentifier: "t_rational_0_by_1",
															typeString: "int_const 0"
														}
													],
													id: 1862,
													isConstant: false,
													isLValue: false,
													isPure: true,
													lValueRequested: false,
													nodeType: "ElementaryTypeNameExpression",
													src: "17283:7:2",
													typeDescriptions: {
														typeIdentifier: "t_type$_t_bytes32_$",
														typeString: "type(bytes32)"
													},
													typeName: "bytes32"
												},
												id: 1864,
												isConstant: false,
												isLValue: false,
												isPure: true,
												kind: "typeConversion",
												lValueRequested: false,
												names: [
												],
												nodeType: "FunctionCall",
												src: "17283:10:2",
												typeDescriptions: {
													typeIdentifier: "t_bytes32",
													typeString: "bytes32"
												}
											},
											functionReturnParameters: 1851,
											id: 1865,
											nodeType: "Return",
											src: "17276:17:2"
										}
									]
								},
								id: 1867,
								nodeType: "IfStatement",
								src: "17139:165:2",
								trueBody: {
									id: 1861,
									nodeType: "Block",
									src: "17182:74:2",
									statements: [
										{
											expression: {
												argumentTypes: null,
												"arguments": [
													{
														argumentTypes: null,
														id: 1858,
														name: "fieldIdTableKey",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 1847,
														src: "17229:15:2",
														typeDescriptions: {
															typeIdentifier: "t_bytes32",
															typeString: "bytes32"
														}
													}
												],
												expression: {
													argumentTypes: [
														{
															typeIdentifier: "t_bytes32",
															typeString: "bytes32"
														}
													],
													expression: {
														argumentTypes: null,
														id: 1856,
														name: "database",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 997,
														src: "17203:8:2",
														typeDescriptions: {
															typeIdentifier: "t_struct$_PolymorphicDictionary_$7490_storage",
															typeString: "struct PolymorphicDictionaryLib.PolymorphicDictionary storage ref"
														}
													},
													id: 1857,
													isConstant: false,
													isLValue: true,
													isPure: false,
													lValueRequested: false,
													memberName: "getBytes32ForKey",
													nodeType: "MemberAccess",
													referencedDeclaration: 7971,
													src: "17203:25:2",
													typeDescriptions: {
														typeIdentifier: "t_function_internal_view$_t_struct$_PolymorphicDictionary_$7490_storage_ptr_$_t_bytes32_$returns$_t_bytes32_$bound_to$_t_struct$_PolymorphicDictionary_$7490_storage_ptr_$",
														typeString: "function (struct PolymorphicDictionaryLib.PolymorphicDictionary storage pointer,bytes32) view returns (bytes32)"
													}
												},
												id: 1859,
												isConstant: false,
												isLValue: false,
												isPure: false,
												kind: "functionCall",
												lValueRequested: false,
												names: [
												],
												nodeType: "FunctionCall",
												src: "17203:42:2",
												typeDescriptions: {
													typeIdentifier: "t_bytes32",
													typeString: "bytes32"
												}
											},
											functionReturnParameters: 1851,
											id: 1860,
											nodeType: "Return",
											src: "17196:49:2"
										}
									]
								}
							}
						]
					},
					documentation: "@dev all data is public, so no need for security checks, we leave the data type handling to the client",
					id: 1869,
					implemented: true,
					kind: "function",
					modifiers: [
					],
					name: "getRowValue",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 1848,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1847,
								name: "fieldIdTableKey",
								nodeType: "VariableDeclaration",
								scope: 1869,
								src: "17071:23:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1846,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "17071:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "17070:25:2"
					},
					returnParameters: {
						id: 1851,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1850,
								name: "",
								nodeType: "VariableDeclaration",
								scope: 1869,
								src: "17119:7:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1849,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "17119:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "17118:9:2"
					},
					scope: 2289,
					src: "17050:260:2",
					stateMutability: "view",
					superFunction: null,
					visibility: "external"
				},
				{
					body: {
						id: 1893,
						nodeType: "Block",
						src: "17402:182:2",
						statements: [
							{
								condition: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1878,
											name: "fieldIdTableKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1871,
											src: "17438:15:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										],
										expression: {
											argumentTypes: null,
											id: 1876,
											name: "database",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 997,
											src: "17417:8:2",
											typeDescriptions: {
												typeIdentifier: "t_struct$_PolymorphicDictionary_$7490_storage",
												typeString: "struct PolymorphicDictionaryLib.PolymorphicDictionary storage ref"
											}
										},
										id: 1877,
										isConstant: false,
										isLValue: true,
										isPure: false,
										lValueRequested: false,
										memberName: "containsKey",
										nodeType: "MemberAccess",
										referencedDeclaration: 7798,
										src: "17417:20:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_view$_t_struct$_PolymorphicDictionary_$7490_storage_ptr_$_t_bytes32_$returns$_t_bool_$bound_to$_t_struct$_PolymorphicDictionary_$7490_storage_ptr_$",
											typeString: "function (struct PolymorphicDictionaryLib.PolymorphicDictionary storage pointer,bytes32) view returns (bool)"
										}
									},
									id: 1879,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "17417:37:2",
									typeDescriptions: {
										typeIdentifier: "t_bool",
										typeString: "bool"
									}
								},
								falseBody: {
									id: 1891,
									nodeType: "Block",
									src: "17534:44:2",
									statements: [
										{
											expression: {
												argumentTypes: null,
												"arguments": [
													{
														argumentTypes: null,
														hexValue: "30",
														id: 1888,
														isConstant: false,
														isLValue: false,
														isPure: true,
														kind: "number",
														lValueRequested: false,
														nodeType: "Literal",
														src: "17565:1:2",
														subdenomination: null,
														typeDescriptions: {
															typeIdentifier: "t_rational_0_by_1",
															typeString: "int_const 0"
														},
														value: "0"
													}
												],
												expression: {
													argumentTypes: [
														{
															typeIdentifier: "t_rational_0_by_1",
															typeString: "int_const 0"
														}
													],
													id: 1887,
													isConstant: false,
													isLValue: false,
													isPure: true,
													lValueRequested: false,
													nodeType: "NewExpression",
													src: "17555:9:2",
													typeDescriptions: {
														typeIdentifier: "t_function_objectcreation_pure$_t_uint256_$returns$_t_bytes_memory_$",
														typeString: "function (uint256) pure returns (bytes memory)"
													},
													typeName: {
														id: 1886,
														name: "bytes",
														nodeType: "ElementaryTypeName",
														src: "17559:5:2",
														typeDescriptions: {
															typeIdentifier: "t_bytes_storage_ptr",
															typeString: "bytes"
														}
													}
												},
												id: 1889,
												isConstant: false,
												isLValue: false,
												isPure: true,
												kind: "functionCall",
												lValueRequested: false,
												names: [
												],
												nodeType: "FunctionCall",
												src: "17555:12:2",
												typeDescriptions: {
													typeIdentifier: "t_bytes_memory",
													typeString: "bytes memory"
												}
											},
											functionReturnParameters: 1875,
											id: 1890,
											nodeType: "Return",
											src: "17548:19:2"
										}
									]
								},
								id: 1892,
								nodeType: "IfStatement",
								src: "17413:165:2",
								trueBody: {
									id: 1885,
									nodeType: "Block",
									src: "17456:72:2",
									statements: [
										{
											expression: {
												argumentTypes: null,
												"arguments": [
													{
														argumentTypes: null,
														id: 1882,
														name: "fieldIdTableKey",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 1871,
														src: "17501:15:2",
														typeDescriptions: {
															typeIdentifier: "t_bytes32",
															typeString: "bytes32"
														}
													}
												],
												expression: {
													argumentTypes: [
														{
															typeIdentifier: "t_bytes32",
															typeString: "bytes32"
														}
													],
													expression: {
														argumentTypes: null,
														id: 1880,
														name: "database",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 997,
														src: "17477:8:2",
														typeDescriptions: {
															typeIdentifier: "t_struct$_PolymorphicDictionary_$7490_storage",
															typeString: "struct PolymorphicDictionaryLib.PolymorphicDictionary storage ref"
														}
													},
													id: 1881,
													isConstant: false,
													isLValue: true,
													isPure: false,
													lValueRequested: false,
													memberName: "getBytesForKey",
													nodeType: "MemberAccess",
													referencedDeclaration: 8063,
													src: "17477:23:2",
													typeDescriptions: {
														typeIdentifier: "t_function_internal_view$_t_struct$_PolymorphicDictionary_$7490_storage_ptr_$_t_bytes32_$returns$_t_bytes_memory_ptr_$bound_to$_t_struct$_PolymorphicDictionary_$7490_storage_ptr_$",
														typeString: "function (struct PolymorphicDictionaryLib.PolymorphicDictionary storage pointer,bytes32) view returns (bytes memory)"
													}
												},
												id: 1883,
												isConstant: false,
												isLValue: false,
												isPure: false,
												kind: "functionCall",
												lValueRequested: false,
												names: [
												],
												nodeType: "FunctionCall",
												src: "17477:40:2",
												typeDescriptions: {
													typeIdentifier: "t_bytes_memory_ptr",
													typeString: "bytes memory"
												}
											},
											functionReturnParameters: 1875,
											id: 1884,
											nodeType: "Return",
											src: "17470:47:2"
										}
									]
								}
							}
						]
					},
					documentation: null,
					id: 1894,
					implemented: true,
					kind: "function",
					modifiers: [
					],
					name: "getRowValueVar",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 1872,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1871,
								name: "fieldIdTableKey",
								nodeType: "VariableDeclaration",
								scope: 1894,
								src: "17340:23:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1870,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "17340:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "17339:25:2"
					},
					returnParameters: {
						id: 1875,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1874,
								name: "",
								nodeType: "VariableDeclaration",
								scope: 1894,
								src: "17388:12:2",
								stateVariable: false,
								storageLocation: "memory",
								typeDescriptions: {
									typeIdentifier: "t_bytes_memory_ptr",
									typeString: "bytes"
								},
								typeName: {
									id: 1873,
									name: "bytes",
									nodeType: "ElementaryTypeName",
									src: "17388:5:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes_storage_ptr",
										typeString: "bytes"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "17387:14:2"
					},
					scope: 2289,
					src: "17316:268:2",
					stateMutability: "view",
					superFunction: null,
					visibility: "external"
				},
				{
					body: {
						id: 1917,
						nodeType: "Block",
						src: "17872:136:2",
						statements: [
							{
								expression: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											commonType: {
												typeIdentifier: "t_bool",
												typeString: "bool"
											},
											id: 1908,
											isConstant: false,
											isLValue: false,
											isPure: false,
											lValueRequested: false,
											leftExpression: {
												argumentTypes: null,
												"arguments": [
													{
														argumentTypes: null,
														id: 1905,
														name: "tableKey",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 1896,
														src: "17911:8:2",
														typeDescriptions: {
															typeIdentifier: "t_bytes32",
															typeString: "bytes32"
														}
													}
												],
												expression: {
													argumentTypes: [
														{
															typeIdentifier: "t_bytes32",
															typeString: "bytes32"
														}
													],
													expression: {
														argumentTypes: null,
														id: 1903,
														name: "tableId",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 986,
														src: "17891:7:2",
														typeDescriptions: {
															typeIdentifier: "t_struct$_Bytes32SetDictionary_$6250_storage",
															typeString: "struct Bytes32SetDictionaryLib.Bytes32SetDictionary storage ref"
														}
													},
													id: 1904,
													isConstant: false,
													isLValue: true,
													isPure: false,
													lValueRequested: false,
													memberName: "containsKey",
													nodeType: "MemberAccess",
													referencedDeclaration: 6282,
													src: "17891:19:2",
													typeDescriptions: {
														typeIdentifier: "t_function_internal_view$_t_struct$_Bytes32SetDictionary_$6250_storage_ptr_$_t_bytes32_$returns$_t_bool_$bound_to$_t_struct$_Bytes32SetDictionary_$6250_storage_ptr_$",
														typeString: "function (struct Bytes32SetDictionaryLib.Bytes32SetDictionary storage pointer,bytes32) view returns (bool)"
													}
												},
												id: 1906,
												isConstant: false,
												isLValue: false,
												isPure: false,
												kind: "functionCall",
												lValueRequested: false,
												names: [
												],
												nodeType: "FunctionCall",
												src: "17891:29:2",
												typeDescriptions: {
													typeIdentifier: "t_bool",
													typeString: "bool"
												}
											},
											nodeType: "BinaryOperation",
											operator: "==",
											rightExpression: {
												argumentTypes: null,
												hexValue: "74727565",
												id: 1907,
												isConstant: false,
												isLValue: false,
												isPure: true,
												kind: "bool",
												lValueRequested: false,
												nodeType: "Literal",
												src: "17924:4:2",
												subdenomination: null,
												typeDescriptions: {
													typeIdentifier: "t_bool",
													typeString: "bool"
												},
												value: "true"
											},
											src: "17891:37:2",
											typeDescriptions: {
												typeIdentifier: "t_bool",
												typeString: "bool"
											}
										},
										{
											argumentTypes: null,
											hexValue: "7461626c65206e6f742063726561746564",
											id: 1909,
											isConstant: false,
											isLValue: false,
											isPure: true,
											kind: "string",
											lValueRequested: false,
											nodeType: "Literal",
											src: "17930:19:2",
											subdenomination: null,
											typeDescriptions: {
												typeIdentifier: "t_stringliteral_db6f56d35b8b4ab5d0197ec2e5e2f49c98a4f29978dd7ddea23231a13bd6f2fb",
												typeString: "literal_string \"table not created\""
											},
											value: "table not created"
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bool",
												typeString: "bool"
											},
											{
												typeIdentifier: "t_stringliteral_db6f56d35b8b4ab5d0197ec2e5e2f49c98a4f29978dd7ddea23231a13bd6f2fb",
												typeString: "literal_string \"table not created\""
											}
										],
										id: 1902,
										name: "require",
										nodeType: "Identifier",
										overloadedDeclarations: [
											11011,
											11012
										],
										referencedDeclaration: 11012,
										src: "17883:7:2",
										typeDescriptions: {
											typeIdentifier: "t_function_require_pure$_t_bool_$_t_string_memory_ptr_$returns$__$",
											typeString: "function (bool,string memory) pure"
										}
									},
									id: 1910,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "17883:67:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 1911,
								nodeType: "ExpressionStatement",
								src: "17883:67:2"
							},
							{
								expression: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1914,
											name: "tableKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1896,
											src: "17992:8:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										],
										expression: {
											argumentTypes: null,
											id: 1912,
											name: "tableId",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 986,
											src: "17968:7:2",
											typeDescriptions: {
												typeIdentifier: "t_struct$_Bytes32SetDictionary_$6250_storage",
												typeString: "struct Bytes32SetDictionaryLib.Bytes32SetDictionary storage ref"
											}
										},
										id: 1913,
										isConstant: false,
										isLValue: true,
										isPure: false,
										lValueRequested: false,
										memberName: "enumerateForKey",
										nodeType: "MemberAccess",
										referencedDeclaration: 6491,
										src: "17968:23:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_view$_t_struct$_Bytes32SetDictionary_$6250_storage_ptr_$_t_bytes32_$returns$_t_array$_t_bytes32_$dyn_memory_ptr_$bound_to$_t_struct$_Bytes32SetDictionary_$6250_storage_ptr_$",
											typeString: "function (struct Bytes32SetDictionaryLib.Bytes32SetDictionary storage pointer,bytes32) view returns (bytes32[] memory)"
										}
									},
									id: 1915,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "17968:33:2",
									typeDescriptions: {
										typeIdentifier: "t_array$_t_bytes32_$dyn_memory_ptr",
										typeString: "bytes32[] memory"
									}
								},
								functionReturnParameters: 1901,
								id: 1916,
								nodeType: "Return",
								src: "17961:40:2"
							}
						]
					},
					documentation: "@dev Warning this produces an Error: overflow (operation=\"setValue\", fault=\"overflow\", details=\"Number can only safely store up to 53 bits\")\n     if the table doesn't exist",
					id: 1918,
					implemented: true,
					kind: "function",
					modifiers: [
					],
					name: "getTableIds",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 1897,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1896,
								name: "tableKey",
								nodeType: "VariableDeclaration",
								scope: 1918,
								src: "17814:16:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1895,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "17814:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "17813:18:2"
					},
					returnParameters: {
						id: 1901,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1900,
								name: "",
								nodeType: "VariableDeclaration",
								scope: 1918,
								src: "17855:16:2",
								stateVariable: false,
								storageLocation: "memory",
								typeDescriptions: {
									typeIdentifier: "t_array$_t_bytes32_$dyn_memory_ptr",
									typeString: "bytes32[]"
								},
								typeName: {
									baseType: {
										id: 1898,
										name: "bytes32",
										nodeType: "ElementaryTypeName",
										src: "17855:7:2",
										typeDescriptions: {
											typeIdentifier: "t_bytes32",
											typeString: "bytes32"
										}
									},
									id: 1899,
									length: null,
									nodeType: "ArrayTypeName",
									src: "17855:9:2",
									typeDescriptions: {
										typeIdentifier: "t_array$_t_bytes32_$dyn_storage_ptr",
										typeString: "bytes32[]"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "17854:18:2"
					},
					scope: 2289,
					src: "17793:215:2",
					stateMutability: "view",
					superFunction: null,
					visibility: "external"
				},
				{
					body: {
						id: 1933,
						nodeType: "Block",
						src: "18094:65:2",
						statements: [
							{
								expression: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1929,
											name: "tableKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1920,
											src: "18139:8:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										{
											argumentTypes: null,
											id: 1930,
											name: "id",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1922,
											src: "18149:2:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											},
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										],
										expression: {
											argumentTypes: null,
											id: 1927,
											name: "tableId",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 986,
											src: "18111:7:2",
											typeDescriptions: {
												typeIdentifier: "t_struct$_Bytes32SetDictionary_$6250_storage",
												typeString: "struct Bytes32SetDictionaryLib.Bytes32SetDictionary storage ref"
											}
										},
										id: 1928,
										isConstant: false,
										isLValue: true,
										isPure: false,
										lValueRequested: false,
										memberName: "containsValueForKey",
										nodeType: "MemberAccess",
										referencedDeclaration: 6437,
										src: "18111:27:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_view$_t_struct$_Bytes32SetDictionary_$6250_storage_ptr_$_t_bytes32_$_t_bytes32_$returns$_t_bool_$bound_to$_t_struct$_Bytes32SetDictionary_$6250_storage_ptr_$",
											typeString: "function (struct Bytes32SetDictionaryLib.Bytes32SetDictionary storage pointer,bytes32,bytes32) view returns (bool)"
										}
									},
									id: 1931,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "18111:41:2",
									typeDescriptions: {
										typeIdentifier: "t_bool",
										typeString: "bool"
									}
								},
								functionReturnParameters: 1926,
								id: 1932,
								nodeType: "Return",
								src: "18104:48:2"
							}
						]
					},
					documentation: null,
					id: 1934,
					implemented: true,
					kind: "function",
					modifiers: [
					],
					name: "getIdExists",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 1923,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1920,
								name: "tableKey",
								nodeType: "VariableDeclaration",
								scope: 1934,
								src: "18035:16:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1919,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "18035:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							},
							{
								constant: false,
								id: 1922,
								name: "id",
								nodeType: "VariableDeclaration",
								scope: 1934,
								src: "18053:10:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1921,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "18053:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "18034:30:2"
					},
					returnParameters: {
						id: 1926,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1925,
								name: "",
								nodeType: "VariableDeclaration",
								scope: 1934,
								src: "18088:4:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bool",
									typeString: "bool"
								},
								typeName: {
									id: 1924,
									name: "bool",
									nodeType: "ElementaryTypeName",
									src: "18088:4:2",
									typeDescriptions: {
										typeIdentifier: "t_bool",
										typeString: "bool"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "18087:6:2"
					},
					scope: 2289,
					src: "18014:145:2",
					stateMutability: "view",
					superFunction: null,
					visibility: "external"
				},
				{
					body: {
						id: 1959,
						nodeType: "Block",
						src: "18454:237:2",
						statements: [
							{
								assignments: [
									1944
								],
								declarations: [
									{
										constant: false,
										id: 1944,
										name: "concat",
										nodeType: "VariableDeclaration",
										scope: 1959,
										src: "18464:19:2",
										stateVariable: false,
										storageLocation: "memory",
										typeDescriptions: {
											typeIdentifier: "t_bytes_memory_ptr",
											typeString: "bytes"
										},
										typeName: {
											id: 1943,
											name: "bytes",
											nodeType: "ElementaryTypeName",
											src: "18464:5:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes_storage_ptr",
												typeString: "bytes"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 1949,
								initialValue: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											hexValue: "3634",
											id: 1947,
											isConstant: false,
											isLValue: false,
											isPure: true,
											kind: "number",
											lValueRequested: false,
											nodeType: "Literal",
											src: "18496:2:2",
											subdenomination: null,
											typeDescriptions: {
												typeIdentifier: "t_rational_64_by_1",
												typeString: "int_const 64"
											},
											value: "64"
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_rational_64_by_1",
												typeString: "int_const 64"
											}
										],
										id: 1946,
										isConstant: false,
										isLValue: false,
										isPure: true,
										lValueRequested: false,
										nodeType: "NewExpression",
										src: "18486:9:2",
										typeDescriptions: {
											typeIdentifier: "t_function_objectcreation_pure$_t_uint256_$returns$_t_bytes_memory_$",
											typeString: "function (uint256) pure returns (bytes memory)"
										},
										typeName: {
											id: 1945,
											name: "bytes",
											nodeType: "ElementaryTypeName",
											src: "18490:5:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes_storage_ptr",
												typeString: "bytes"
											}
										}
									},
									id: 1948,
									isConstant: false,
									isLValue: false,
									isPure: true,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "18486:13:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes_memory",
										typeString: "bytes memory"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "18464:35:2"
							},
							{
								externalReferences: [
									{
										subKey: {
											declaration: 1936,
											isOffset: false,
											isSlot: false,
											src: "18557:6:2",
											valueSize: 1
										}
									},
									{
										concat: {
											declaration: 1944,
											isOffset: false,
											isSlot: false,
											src: "18544:6:2",
											valueSize: 1
										}
									},
									{
										base: {
											declaration: 1938,
											isOffset: false,
											isSlot: false,
											src: "18601:4:2",
											valueSize: 1
										}
									},
									{
										concat: {
											declaration: 1944,
											isOffset: false,
											isSlot: false,
											src: "18588:6:2",
											valueSize: 1
										}
									}
								],
								id: 1950,
								nodeType: "InlineAssembly",
								operations: "{\n    mstore(add(concat, 64), subKey)\n    mstore(add(concat, 32), base)\n}",
								src: "18510:123:2"
							},
							{
								assignments: [
									1952
								],
								declarations: [
									{
										constant: false,
										id: 1952,
										name: "result",
										nodeType: "VariableDeclaration",
										scope: 1959,
										src: "18626:14:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_bytes32",
											typeString: "bytes32"
										},
										typeName: {
											id: 1951,
											name: "bytes32",
											nodeType: "ElementaryTypeName",
											src: "18626:7:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 1956,
								initialValue: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1954,
											name: "concat",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1944,
											src: "18653:6:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes_memory_ptr",
												typeString: "bytes memory"
											}
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bytes_memory_ptr",
												typeString: "bytes memory"
											}
										],
										id: 1953,
										name: "keccak256",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 11002,
										src: "18643:9:2",
										typeDescriptions: {
											typeIdentifier: "t_function_keccak256_pure$_t_bytes_memory_ptr_$returns$_t_bytes32_$",
											typeString: "function (bytes memory) pure returns (bytes32)"
										}
									},
									id: 1955,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "18643:17:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "18626:34:2"
							},
							{
								expression: {
									argumentTypes: null,
									id: 1957,
									name: "result",
									nodeType: "Identifier",
									overloadedDeclarations: [
									],
									referencedDeclaration: 1952,
									src: "18678:6:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								functionReturnParameters: 1942,
								id: 1958,
								nodeType: "Return",
								src: "18671:13:2"
							}
						]
					},
					documentation: null,
					id: 1960,
					implemented: true,
					kind: "function",
					modifiers: [
					],
					name: "namehash",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 1939,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1936,
								name: "subKey",
								nodeType: "VariableDeclaration",
								scope: 1960,
								src: "18392:14:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1935,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "18392:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							},
							{
								constant: false,
								id: 1938,
								name: "base",
								nodeType: "VariableDeclaration",
								scope: 1960,
								src: "18408:12:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1937,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "18408:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "18391:30:2"
					},
					returnParameters: {
						id: 1942,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1941,
								name: "",
								nodeType: "VariableDeclaration",
								scope: 1960,
								src: "18445:7:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1940,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "18445:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "18444:9:2"
					},
					scope: 2289,
					src: "18374:317:2",
					stateMutability: "pure",
					superFunction: null,
					visibility: "internal"
				},
				{
					body: {
						id: 2002,
						nodeType: "Block",
						src: "18929:231:2",
						statements: [
							{
								expression: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											commonType: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											},
											id: 1974,
											isConstant: false,
											isLValue: false,
											isPure: false,
											lValueRequested: false,
											leftExpression: {
												argumentTypes: null,
												baseExpression: {
													argumentTypes: null,
													id: 1970,
													name: "_table",
													nodeType: "Identifier",
													overloadedDeclarations: [
													],
													referencedDeclaration: 984,
													src: "18947:6:2",
													typeDescriptions: {
														typeIdentifier: "t_mapping$_t_bytes32_$_t_bytes32_$",
														typeString: "mapping(bytes32 => bytes32)"
													}
												},
												id: 1972,
												indexExpression: {
													argumentTypes: null,
													id: 1971,
													name: "_tableKey",
													nodeType: "Identifier",
													overloadedDeclarations: [
													],
													referencedDeclaration: 1962,
													src: "18954:9:2",
													typeDescriptions: {
														typeIdentifier: "t_bytes32",
														typeString: "bytes32"
													}
												},
												isConstant: false,
												isLValue: true,
												isPure: false,
												lValueRequested: false,
												nodeType: "IndexAccess",
												src: "18947:17:2",
												typeDescriptions: {
													typeIdentifier: "t_bytes32",
													typeString: "bytes32"
												}
											},
											nodeType: "BinaryOperation",
											operator: ">",
											rightExpression: {
												argumentTypes: null,
												hexValue: "30",
												id: 1973,
												isConstant: false,
												isLValue: false,
												isPure: true,
												kind: "number",
												lValueRequested: false,
												nodeType: "Literal",
												src: "18967:1:2",
												subdenomination: null,
												typeDescriptions: {
													typeIdentifier: "t_rational_0_by_1",
													typeString: "int_const 0"
												},
												value: "0"
											},
											src: "18947:21:2",
											typeDescriptions: {
												typeIdentifier: "t_bool",
												typeString: "bool"
											}
										},
										{
											argumentTypes: null,
											hexValue: "7461626c6520646f6573206e6f74206578697374",
											id: 1975,
											isConstant: false,
											isLValue: false,
											isPure: true,
											kind: "string",
											lValueRequested: false,
											nodeType: "Literal",
											src: "18970:22:2",
											subdenomination: null,
											typeDescriptions: {
												typeIdentifier: "t_stringliteral_f7e9b396f082020836b3f74274104d95ad6dff938f95c751e799f51d9bb78cba",
												typeString: "literal_string \"table does not exist\""
											},
											value: "table does not exist"
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bool",
												typeString: "bool"
											},
											{
												typeIdentifier: "t_stringliteral_f7e9b396f082020836b3f74274104d95ad6dff938f95c751e799f51d9bb78cba",
												typeString: "literal_string \"table does not exist\""
											}
										],
										id: 1969,
										name: "require",
										nodeType: "Identifier",
										overloadedDeclarations: [
											11011,
											11012
										],
										referencedDeclaration: 11012,
										src: "18939:7:2",
										typeDescriptions: {
											typeIdentifier: "t_function_require_pure$_t_bool_$_t_string_memory_ptr_$returns$__$",
											typeString: "function (bool,string memory) pure"
										}
									},
									id: 1976,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "18939:54:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 1977,
								nodeType: "ExpressionStatement",
								src: "18939:54:2"
							},
							{
								assignments: [
									1979
								],
								declarations: [
									{
										constant: false,
										id: 1979,
										name: "tableMetadata",
										nodeType: "VariableDeclaration",
										scope: 2002,
										src: "19004:21:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										},
										typeName: {
											id: 1978,
											name: "uint256",
											nodeType: "ElementaryTypeName",
											src: "19004:7:2",
											typeDescriptions: {
												typeIdentifier: "t_uint256",
												typeString: "uint256"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 1985,
								initialValue: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											baseExpression: {
												argumentTypes: null,
												id: 1981,
												name: "_table",
												nodeType: "Identifier",
												overloadedDeclarations: [
												],
												referencedDeclaration: 984,
												src: "19036:6:2",
												typeDescriptions: {
													typeIdentifier: "t_mapping$_t_bytes32_$_t_bytes32_$",
													typeString: "mapping(bytes32 => bytes32)"
												}
											},
											id: 1983,
											indexExpression: {
												argumentTypes: null,
												id: 1982,
												name: "_tableKey",
												nodeType: "Identifier",
												overloadedDeclarations: [
												],
												referencedDeclaration: 1962,
												src: "19043:9:2",
												typeDescriptions: {
													typeIdentifier: "t_bytes32",
													typeString: "bytes32"
												}
											},
											isConstant: false,
											isLValue: true,
											isPure: false,
											lValueRequested: false,
											nodeType: "IndexAccess",
											src: "19036:17:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										],
										id: 1980,
										isConstant: false,
										isLValue: false,
										isPure: true,
										lValueRequested: false,
										nodeType: "ElementaryTypeNameExpression",
										src: "19028:7:2",
										typeDescriptions: {
											typeIdentifier: "t_type$_t_uint256_$",
											typeString: "type(uint256)"
										},
										typeName: "uint256"
									},
									id: 1984,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "typeConversion",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "19028:26:2",
									typeDescriptions: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "19004:50:2"
							},
							{
								expression: {
									argumentTypes: null,
									id: 1992,
									isConstant: false,
									isLValue: false,
									isPure: false,
									lValueRequested: false,
									leftHandSide: {
										argumentTypes: null,
										id: 1986,
										name: "permission",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 1965,
										src: "19065:10:2",
										typeDescriptions: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										}
									},
									nodeType: "Assignment",
									operator: "=",
									rightHandSide: {
										argumentTypes: null,
										"arguments": [
											{
												argumentTypes: null,
												"arguments": [
													{
														argumentTypes: null,
														id: 1989,
														name: "tableMetadata",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 1979,
														src: "19092:13:2",
														typeDescriptions: {
															typeIdentifier: "t_uint256",
															typeString: "uint256"
														}
													}
												],
												expression: {
													argumentTypes: [
														{
															typeIdentifier: "t_uint256",
															typeString: "uint256"
														}
													],
													id: 1988,
													isConstant: false,
													isLValue: false,
													isPure: true,
													lValueRequested: false,
													nodeType: "ElementaryTypeNameExpression",
													src: "19086:5:2",
													typeDescriptions: {
														typeIdentifier: "t_type$_t_uint8_$",
														typeString: "type(uint8)"
													},
													typeName: "uint8"
												},
												id: 1990,
												isConstant: false,
												isLValue: false,
												isPure: false,
												kind: "typeConversion",
												lValueRequested: false,
												names: [
												],
												nodeType: "FunctionCall",
												src: "19086:20:2",
												typeDescriptions: {
													typeIdentifier: "t_uint8",
													typeString: "uint8"
												}
											}
										],
										expression: {
											argumentTypes: [
												{
													typeIdentifier: "t_uint8",
													typeString: "uint8"
												}
											],
											id: 1987,
											isConstant: false,
											isLValue: false,
											isPure: true,
											lValueRequested: false,
											nodeType: "ElementaryTypeNameExpression",
											src: "19078:7:2",
											typeDescriptions: {
												typeIdentifier: "t_type$_t_uint256_$",
												typeString: "type(uint256)"
											},
											typeName: "uint256"
										},
										id: 1991,
										isConstant: false,
										isLValue: false,
										isPure: false,
										kind: "typeConversion",
										lValueRequested: false,
										names: [
										],
										nodeType: "FunctionCall",
										src: "19078:29:2",
										typeDescriptions: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										}
									},
									src: "19065:42:2",
									typeDescriptions: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									}
								},
								id: 1993,
								nodeType: "ExpressionStatement",
								src: "19065:42:2"
							},
							{
								expression: {
									argumentTypes: null,
									id: 2000,
									isConstant: false,
									isLValue: false,
									isPure: false,
									lValueRequested: false,
									leftHandSide: {
										argumentTypes: null,
										id: 1994,
										name: "delegate",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 1967,
										src: "19117:8:2",
										typeDescriptions: {
											typeIdentifier: "t_address",
											typeString: "address"
										}
									},
									nodeType: "Assignment",
									operator: "=",
									rightHandSide: {
										argumentTypes: null,
										"arguments": [
											{
												argumentTypes: null,
												commonType: {
													typeIdentifier: "t_uint256",
													typeString: "uint256"
												},
												id: 1998,
												isConstant: false,
												isLValue: false,
												isPure: false,
												lValueRequested: false,
												leftExpression: {
													argumentTypes: null,
													id: 1996,
													name: "tableMetadata",
													nodeType: "Identifier",
													overloadedDeclarations: [
													],
													referencedDeclaration: 1979,
													src: "19136:13:2",
													typeDescriptions: {
														typeIdentifier: "t_uint256",
														typeString: "uint256"
													}
												},
												nodeType: "BinaryOperation",
												operator: ">>",
												rightExpression: {
													argumentTypes: null,
													hexValue: "38",
													id: 1997,
													isConstant: false,
													isLValue: false,
													isPure: true,
													kind: "number",
													lValueRequested: false,
													nodeType: "Literal",
													src: "19151:1:2",
													subdenomination: null,
													typeDescriptions: {
														typeIdentifier: "t_rational_8_by_1",
														typeString: "int_const 8"
													},
													value: "8"
												},
												src: "19136:16:2",
												typeDescriptions: {
													typeIdentifier: "t_uint256",
													typeString: "uint256"
												}
											}
										],
										expression: {
											argumentTypes: [
												{
													typeIdentifier: "t_uint256",
													typeString: "uint256"
												}
											],
											id: 1995,
											isConstant: false,
											isLValue: false,
											isPure: true,
											lValueRequested: false,
											nodeType: "ElementaryTypeNameExpression",
											src: "19128:7:2",
											typeDescriptions: {
												typeIdentifier: "t_type$_t_address_$",
												typeString: "type(address)"
											},
											typeName: "address"
										},
										id: 1999,
										isConstant: false,
										isLValue: false,
										isPure: false,
										kind: "typeConversion",
										lValueRequested: false,
										names: [
										],
										nodeType: "FunctionCall",
										src: "19128:25:2",
										typeDescriptions: {
											typeIdentifier: "t_address_payable",
											typeString: "address payable"
										}
									},
									src: "19117:36:2",
									typeDescriptions: {
										typeIdentifier: "t_address",
										typeString: "address"
									}
								},
								id: 2001,
								nodeType: "ExpressionStatement",
								src: "19117:36:2"
							}
						]
					},
					documentation: null,
					id: 2003,
					implemented: true,
					kind: "function",
					modifiers: [
					],
					name: "getTableMetadata",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 1963,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1962,
								name: "_tableKey",
								nodeType: "VariableDeclaration",
								scope: 2003,
								src: "18823:17:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1961,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "18823:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "18822:19:2"
					},
					returnParameters: {
						id: 1968,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1965,
								name: "permission",
								nodeType: "VariableDeclaration",
								scope: 2003,
								src: "18887:18:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_uint256",
									typeString: "uint256"
								},
								typeName: {
									id: 1964,
									name: "uint256",
									nodeType: "ElementaryTypeName",
									src: "18887:7:2",
									typeDescriptions: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									}
								},
								value: null,
								visibility: "internal"
							},
							{
								constant: false,
								id: 1967,
								name: "delegate",
								nodeType: "VariableDeclaration",
								scope: 2003,
								src: "18907:16:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_address",
									typeString: "address"
								},
								typeName: {
									id: 1966,
									name: "address",
									nodeType: "ElementaryTypeName",
									src: "18907:7:2",
									stateMutability: "nonpayable",
									typeDescriptions: {
										typeIdentifier: "t_address",
										typeString: "address"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "18886:38:2"
					},
					scope: 2289,
					src: "18797:363:2",
					stateMutability: "view",
					superFunction: null,
					visibility: "public"
				},
				{
					body: {
						id: 2037,
						nodeType: "Block",
						src: "19265:176:2",
						statements: [
							{
								assignments: [
									2015
								],
								declarations: [
									{
										constant: false,
										id: 2015,
										name: "tableMetadata",
										nodeType: "VariableDeclaration",
										scope: 2037,
										src: "19275:21:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										},
										typeName: {
											id: 2014,
											name: "uint256",
											nodeType: "ElementaryTypeName",
											src: "19275:7:2",
											typeDescriptions: {
												typeIdentifier: "t_uint256",
												typeString: "uint256"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 2016,
								initialValue: null,
								nodeType: "VariableDeclarationStatement",
								src: "19275:21:2"
							},
							{
								expression: {
									argumentTypes: null,
									id: 2019,
									isConstant: false,
									isLValue: false,
									isPure: false,
									lValueRequested: false,
									leftHandSide: {
										argumentTypes: null,
										id: 2017,
										name: "tableMetadata",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 2015,
										src: "19307:13:2",
										typeDescriptions: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										}
									},
									nodeType: "Assignment",
									operator: "|=",
									rightHandSide: {
										argumentTypes: null,
										id: 2018,
										name: "permission",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 2007,
										src: "19324:10:2",
										typeDescriptions: {
											typeIdentifier: "t_uint8",
											typeString: "uint8"
										}
									},
									src: "19307:27:2",
									typeDescriptions: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									}
								},
								id: 2020,
								nodeType: "ExpressionStatement",
								src: "19307:27:2"
							},
							{
								expression: {
									argumentTypes: null,
									id: 2027,
									isConstant: false,
									isLValue: false,
									isPure: false,
									lValueRequested: false,
									leftHandSide: {
										argumentTypes: null,
										id: 2021,
										name: "tableMetadata",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 2015,
										src: "19344:13:2",
										typeDescriptions: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										}
									},
									nodeType: "Assignment",
									operator: "|=",
									rightHandSide: {
										argumentTypes: null,
										commonType: {
											typeIdentifier: "t_uint160",
											typeString: "uint160"
										},
										id: 2026,
										isConstant: false,
										isLValue: false,
										isPure: false,
										lValueRequested: false,
										leftExpression: {
											argumentTypes: null,
											"arguments": [
												{
													argumentTypes: null,
													id: 2023,
													name: "delegate",
													nodeType: "Identifier",
													overloadedDeclarations: [
													],
													referencedDeclaration: 2009,
													src: "19369:8:2",
													typeDescriptions: {
														typeIdentifier: "t_address",
														typeString: "address"
													}
												}
											],
											expression: {
												argumentTypes: [
													{
														typeIdentifier: "t_address",
														typeString: "address"
													}
												],
												id: 2022,
												isConstant: false,
												isLValue: false,
												isPure: true,
												lValueRequested: false,
												nodeType: "ElementaryTypeNameExpression",
												src: "19361:7:2",
												typeDescriptions: {
													typeIdentifier: "t_type$_t_uint160_$",
													typeString: "type(uint160)"
												},
												typeName: "uint160"
											},
											id: 2024,
											isConstant: false,
											isLValue: false,
											isPure: false,
											kind: "typeConversion",
											lValueRequested: false,
											names: [
											],
											nodeType: "FunctionCall",
											src: "19361:17:2",
											typeDescriptions: {
												typeIdentifier: "t_uint160",
												typeString: "uint160"
											}
										},
										nodeType: "BinaryOperation",
										operator: "<<",
										rightExpression: {
											argumentTypes: null,
											hexValue: "38",
											id: 2025,
											isConstant: false,
											isLValue: false,
											isPure: true,
											kind: "number",
											lValueRequested: false,
											nodeType: "Literal",
											src: "19380:1:2",
											subdenomination: null,
											typeDescriptions: {
												typeIdentifier: "t_rational_8_by_1",
												typeString: "int_const 8"
											},
											value: "8"
										},
										src: "19361:20:2",
										typeDescriptions: {
											typeIdentifier: "t_uint160",
											typeString: "uint160"
										}
									},
									src: "19344:37:2",
									typeDescriptions: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									}
								},
								id: 2028,
								nodeType: "ExpressionStatement",
								src: "19344:37:2"
							},
							{
								expression: {
									argumentTypes: null,
									id: 2035,
									isConstant: false,
									isLValue: false,
									isPure: false,
									lValueRequested: false,
									leftHandSide: {
										argumentTypes: null,
										baseExpression: {
											argumentTypes: null,
											id: 2029,
											name: "_table",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 984,
											src: "19392:6:2",
											typeDescriptions: {
												typeIdentifier: "t_mapping$_t_bytes32_$_t_bytes32_$",
												typeString: "mapping(bytes32 => bytes32)"
											}
										},
										id: 2031,
										indexExpression: {
											argumentTypes: null,
											id: 2030,
											name: "_tableKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 2005,
											src: "19399:9:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										isConstant: false,
										isLValue: true,
										isPure: false,
										lValueRequested: true,
										nodeType: "IndexAccess",
										src: "19392:17:2",
										typeDescriptions: {
											typeIdentifier: "t_bytes32",
											typeString: "bytes32"
										}
									},
									nodeType: "Assignment",
									operator: "=",
									rightHandSide: {
										argumentTypes: null,
										"arguments": [
											{
												argumentTypes: null,
												id: 2033,
												name: "tableMetadata",
												nodeType: "Identifier",
												overloadedDeclarations: [
												],
												referencedDeclaration: 2015,
												src: "19420:13:2",
												typeDescriptions: {
													typeIdentifier: "t_uint256",
													typeString: "uint256"
												}
											}
										],
										expression: {
											argumentTypes: [
												{
													typeIdentifier: "t_uint256",
													typeString: "uint256"
												}
											],
											id: 2032,
											isConstant: false,
											isLValue: false,
											isPure: true,
											lValueRequested: false,
											nodeType: "ElementaryTypeNameExpression",
											src: "19412:7:2",
											typeDescriptions: {
												typeIdentifier: "t_type$_t_bytes32_$",
												typeString: "type(bytes32)"
											},
											typeName: "bytes32"
										},
										id: 2034,
										isConstant: false,
										isLValue: false,
										isPure: false,
										kind: "typeConversion",
										lValueRequested: false,
										names: [
										],
										nodeType: "FunctionCall",
										src: "19412:22:2",
										typeDescriptions: {
											typeIdentifier: "t_bytes32",
											typeString: "bytes32"
										}
									},
									src: "19392:42:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								id: 2036,
								nodeType: "ExpressionStatement",
								src: "19392:42:2"
							}
						]
					},
					documentation: null,
					id: 2038,
					implemented: true,
					kind: "function",
					modifiers: [
						{
							"arguments": null,
							id: 2012,
							modifierName: {
								argumentTypes: null,
								id: 2011,
								name: "onlyOwner",
								nodeType: "Identifier",
								overloadedDeclarations: [
								],
								referencedDeclaration: 5005,
								src: "19255:9:2",
								typeDescriptions: {
									typeIdentifier: "t_modifier$__$",
									typeString: "modifier ()"
								}
							},
							nodeType: "ModifierInvocation",
							src: "19255:9:2"
						}
					],
					name: "setTableMetadata",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 2010,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 2005,
								name: "_tableKey",
								nodeType: "VariableDeclaration",
								scope: 2038,
								src: "19192:17:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 2004,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "19192:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							},
							{
								constant: false,
								id: 2007,
								name: "permission",
								nodeType: "VariableDeclaration",
								scope: 2038,
								src: "19211:16:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_uint8",
									typeString: "uint8"
								},
								typeName: {
									id: 2006,
									name: "uint8",
									nodeType: "ElementaryTypeName",
									src: "19211:5:2",
									typeDescriptions: {
										typeIdentifier: "t_uint8",
										typeString: "uint8"
									}
								},
								value: null,
								visibility: "internal"
							},
							{
								constant: false,
								id: 2009,
								name: "delegate",
								nodeType: "VariableDeclaration",
								scope: 2038,
								src: "19229:16:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_address",
									typeString: "address"
								},
								typeName: {
									id: 2008,
									name: "address",
									nodeType: "ElementaryTypeName",
									src: "19229:7:2",
									stateMutability: "nonpayable",
									typeDescriptions: {
										typeIdentifier: "t_address",
										typeString: "address"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "19191:55:2"
					},
					returnParameters: {
						id: 2013,
						nodeType: "ParameterList",
						parameters: [
						],
						src: "19265:0:2"
					},
					scope: 2289,
					src: "19166:275:2",
					stateMutability: "nonpayable",
					superFunction: null,
					visibility: "private"
				},
				{
					body: {
						id: 2041,
						nodeType: "Block",
						src: "19574:2:2",
						statements: [
						]
					},
					documentation: null,
					id: 2042,
					implemented: true,
					kind: "fallback",
					modifiers: [
					],
					name: "",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 2039,
						nodeType: "ParameterList",
						parameters: [
						],
						src: "19554:2:2"
					},
					returnParameters: {
						id: 2040,
						nodeType: "ParameterList",
						parameters: [
						],
						src: "19574:0:2"
					},
					scope: 2289,
					src: "19546:30:2",
					stateMutability: "payable",
					superFunction: null,
					visibility: "external"
				},
				{
					body: {
						id: 2090,
						nodeType: "Block",
						src: "20115:312:2",
						statements: [
							{
								assignments: [
									2068
								],
								declarations: [
									{
										constant: false,
										id: 2068,
										name: "curDateHashed",
										nodeType: "VariableDeclaration",
										scope: 2090,
										src: "20126:21:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_bytes32",
											typeString: "bytes32"
										},
										typeName: {
											id: 2067,
											name: "bytes32",
											nodeType: "ElementaryTypeName",
											src: "20126:7:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 2071,
								initialValue: {
									argumentTypes: null,
									"arguments": [
									],
									expression: {
										argumentTypes: [
										],
										id: 2069,
										name: "getGsnCounter",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 2187,
										src: "20150:13:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_view$__$returns$_t_bytes32_$",
											typeString: "function () view returns (bytes32)"
										}
									},
									id: 2070,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "20150:15:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "20126:39:2"
							},
							{
								assignments: [
									2073
								],
								declarations: [
									{
										constant: false,
										id: 2073,
										name: "curCounter",
										nodeType: "VariableDeclaration",
										scope: 2090,
										src: "20235:18:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										},
										typeName: {
											id: 2072,
											name: "uint256",
											nodeType: "ElementaryTypeName",
											src: "20235:7:2",
											typeDescriptions: {
												typeIdentifier: "t_uint256",
												typeString: "uint256"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 2077,
								initialValue: {
									argumentTypes: null,
									baseExpression: {
										argumentTypes: null,
										id: 2074,
										name: "gsnCounter",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 972,
										src: "20256:10:2",
										typeDescriptions: {
											typeIdentifier: "t_mapping$_t_bytes32_$_t_uint256_$",
											typeString: "mapping(bytes32 => uint256)"
										}
									},
									id: 2076,
									indexExpression: {
										argumentTypes: null,
										id: 2075,
										name: "curDateHashed",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 2068,
										src: "20267:13:2",
										typeDescriptions: {
											typeIdentifier: "t_bytes32",
											typeString: "bytes32"
										}
									},
									isConstant: false,
									isLValue: true,
									isPure: false,
									lValueRequested: false,
									nodeType: "IndexAccess",
									src: "20256:25:2",
									typeDescriptions: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "20235:46:2"
							},
							{
								condition: {
									argumentTypes: null,
									commonType: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									},
									id: 2080,
									isConstant: false,
									isLValue: false,
									isPure: false,
									lValueRequested: false,
									leftExpression: {
										argumentTypes: null,
										id: 2078,
										name: "curCounter",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 2073,
										src: "20296:10:2",
										typeDescriptions: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										}
									},
									nodeType: "BinaryOperation",
									operator: ">=",
									rightExpression: {
										argumentTypes: null,
										id: 2079,
										name: "gsnMaxCallsPerDay",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 974,
										src: "20310:17:2",
										typeDescriptions: {
											typeIdentifier: "t_uint40",
											typeString: "uint40"
										}
									},
									src: "20296:31:2",
									typeDescriptions: {
										typeIdentifier: "t_bool",
										typeString: "bool"
									}
								},
								falseBody: null,
								id: 2086,
								nodeType: "IfStatement",
								src: "20292:89:2",
								trueBody: {
									id: 2085,
									nodeType: "Block",
									src: "20328:53:2",
									statements: [
										{
											expression: {
												argumentTypes: null,
												"arguments": [
													{
														argumentTypes: null,
														hexValue: "32",
														id: 2082,
														isConstant: false,
														isLValue: false,
														isPure: true,
														kind: "number",
														lValueRequested: false,
														nodeType: "Literal",
														src: "20368:1:2",
														subdenomination: null,
														typeDescriptions: {
															typeIdentifier: "t_rational_2_by_1",
															typeString: "int_const 2"
														},
														value: "2"
													}
												],
												expression: {
													argumentTypes: [
														{
															typeIdentifier: "t_rational_2_by_1",
															typeString: "int_const 2"
														}
													],
													id: 2081,
													name: "_rejectRelayedCall",
													nodeType: "Identifier",
													overloadedDeclarations: [
													],
													referencedDeclaration: 4164,
													src: "20349:18:2",
													typeDescriptions: {
														typeIdentifier: "t_function_internal_pure$_t_uint256_$returns$_t_uint256_$_t_bytes_memory_ptr_$",
														typeString: "function (uint256) pure returns (uint256,bytes memory)"
													}
												},
												id: 2083,
												isConstant: false,
												isLValue: false,
												isPure: false,
												kind: "functionCall",
												lValueRequested: false,
												names: [
												],
												nodeType: "FunctionCall",
												src: "20349:21:2",
												typeDescriptions: {
													typeIdentifier: "t_tuple$_t_uint256_$_t_bytes_memory_ptr_$",
													typeString: "tuple(uint256,bytes memory)"
												}
											},
											functionReturnParameters: 2066,
											id: 2084,
											nodeType: "Return",
											src: "20342:28:2"
										}
									]
								}
							},
							{
								expression: {
									argumentTypes: null,
									"arguments": [
									],
									expression: {
										argumentTypes: [
										],
										id: 2087,
										name: "_approveRelayedCall",
										nodeType: "Identifier",
										overloadedDeclarations: [
											4134,
											4148
										],
										referencedDeclaration: 4134,
										src: "20399:19:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_pure$__$returns$_t_uint256_$_t_bytes_memory_ptr_$",
											typeString: "function () pure returns (uint256,bytes memory)"
										}
									},
									id: 2088,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "20399:21:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$_t_uint256_$_t_bytes_memory_ptr_$",
										typeString: "tuple(uint256,bytes memory)"
									}
								},
								functionReturnParameters: 2066,
								id: 2089,
								nodeType: "Return",
								src: "20392:28:2"
							}
						]
					},
					documentation: "As a first layer of defense we employ a max number of checks per day",
					id: 2091,
					implemented: true,
					kind: "function",
					modifiers: [
					],
					name: "acceptRelayedCall",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 2061,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 2044,
								name: "relay",
								nodeType: "VariableDeclaration",
								scope: 2091,
								src: "19808:13:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_address",
									typeString: "address"
								},
								typeName: {
									id: 2043,
									name: "address",
									nodeType: "ElementaryTypeName",
									src: "19808:7:2",
									stateMutability: "nonpayable",
									typeDescriptions: {
										typeIdentifier: "t_address",
										typeString: "address"
									}
								},
								value: null,
								visibility: "internal"
							},
							{
								constant: false,
								id: 2046,
								name: "from",
								nodeType: "VariableDeclaration",
								scope: 2091,
								src: "19831:12:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_address",
									typeString: "address"
								},
								typeName: {
									id: 2045,
									name: "address",
									nodeType: "ElementaryTypeName",
									src: "19831:7:2",
									stateMutability: "nonpayable",
									typeDescriptions: {
										typeIdentifier: "t_address",
										typeString: "address"
									}
								},
								value: null,
								visibility: "internal"
							},
							{
								constant: false,
								id: 2048,
								name: "encodedFunction",
								nodeType: "VariableDeclaration",
								scope: 2091,
								src: "19853:30:2",
								stateVariable: false,
								storageLocation: "calldata",
								typeDescriptions: {
									typeIdentifier: "t_bytes_calldata_ptr",
									typeString: "bytes"
								},
								typeName: {
									id: 2047,
									name: "bytes",
									nodeType: "ElementaryTypeName",
									src: "19853:5:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes_storage_ptr",
										typeString: "bytes"
									}
								},
								value: null,
								visibility: "internal"
							},
							{
								constant: false,
								id: 2050,
								name: "transactionFee",
								nodeType: "VariableDeclaration",
								scope: 2091,
								src: "19893:22:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_uint256",
									typeString: "uint256"
								},
								typeName: {
									id: 2049,
									name: "uint256",
									nodeType: "ElementaryTypeName",
									src: "19893:7:2",
									typeDescriptions: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									}
								},
								value: null,
								visibility: "internal"
							},
							{
								constant: false,
								id: 2052,
								name: "gasPrice",
								nodeType: "VariableDeclaration",
								scope: 2091,
								src: "19925:16:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_uint256",
									typeString: "uint256"
								},
								typeName: {
									id: 2051,
									name: "uint256",
									nodeType: "ElementaryTypeName",
									src: "19925:7:2",
									typeDescriptions: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									}
								},
								value: null,
								visibility: "internal"
							},
							{
								constant: false,
								id: 2054,
								name: "gasLimit",
								nodeType: "VariableDeclaration",
								scope: 2091,
								src: "19951:16:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_uint256",
									typeString: "uint256"
								},
								typeName: {
									id: 2053,
									name: "uint256",
									nodeType: "ElementaryTypeName",
									src: "19951:7:2",
									typeDescriptions: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									}
								},
								value: null,
								visibility: "internal"
							},
							{
								constant: false,
								id: 2056,
								name: "nonce",
								nodeType: "VariableDeclaration",
								scope: 2091,
								src: "19977:13:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_uint256",
									typeString: "uint256"
								},
								typeName: {
									id: 2055,
									name: "uint256",
									nodeType: "ElementaryTypeName",
									src: "19977:7:2",
									typeDescriptions: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									}
								},
								value: null,
								visibility: "internal"
							},
							{
								constant: false,
								id: 2058,
								name: "approvalData",
								nodeType: "VariableDeclaration",
								scope: 2091,
								src: "20000:27:2",
								stateVariable: false,
								storageLocation: "calldata",
								typeDescriptions: {
									typeIdentifier: "t_bytes_calldata_ptr",
									typeString: "bytes"
								},
								typeName: {
									id: 2057,
									name: "bytes",
									nodeType: "ElementaryTypeName",
									src: "20000:5:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes_storage_ptr",
										typeString: "bytes"
									}
								},
								value: null,
								visibility: "internal"
							},
							{
								constant: false,
								id: 2060,
								name: "maxPossibleCharge",
								nodeType: "VariableDeclaration",
								scope: 2091,
								src: "20037:25:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_uint256",
									typeString: "uint256"
								},
								typeName: {
									id: 2059,
									name: "uint256",
									nodeType: "ElementaryTypeName",
									src: "20037:7:2",
									typeDescriptions: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "19798:270:2"
					},
					returnParameters: {
						id: 2066,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 2063,
								name: "",
								nodeType: "VariableDeclaration",
								scope: 2091,
								src: "20092:7:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_uint256",
									typeString: "uint256"
								},
								typeName: {
									id: 2062,
									name: "uint256",
									nodeType: "ElementaryTypeName",
									src: "20092:7:2",
									typeDescriptions: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									}
								},
								value: null,
								visibility: "internal"
							},
							{
								constant: false,
								id: 2065,
								name: "",
								nodeType: "VariableDeclaration",
								scope: 2091,
								src: "20101:12:2",
								stateVariable: false,
								storageLocation: "memory",
								typeDescriptions: {
									typeIdentifier: "t_bytes_memory_ptr",
									typeString: "bytes"
								},
								typeName: {
									id: 2064,
									name: "bytes",
									nodeType: "ElementaryTypeName",
									src: "20101:5:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes_storage_ptr",
										typeString: "bytes"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "20091:23:2"
					},
					scope: 2289,
					src: "19772:655:2",
					stateMutability: "view",
					superFunction: 4040,
					visibility: "external"
				},
				{
					body: {
						id: 2104,
						nodeType: "Block",
						src: "20495:48:2",
						statements: [
							{
								expression: {
									argumentTypes: null,
									id: 2102,
									isConstant: false,
									isLValue: false,
									isPure: false,
									lValueRequested: false,
									leftHandSide: {
										argumentTypes: null,
										id: 2098,
										name: "gsnMaxCallsPerDay",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 974,
										src: "20505:17:2",
										typeDescriptions: {
											typeIdentifier: "t_uint40",
											typeString: "uint40"
										}
									},
									nodeType: "Assignment",
									operator: "=",
									rightHandSide: {
										argumentTypes: null,
										"arguments": [
											{
												argumentTypes: null,
												id: 2100,
												name: "max",
												nodeType: "Identifier",
												overloadedDeclarations: [
												],
												referencedDeclaration: 2093,
												src: "20532:3:2",
												typeDescriptions: {
													typeIdentifier: "t_uint256",
													typeString: "uint256"
												}
											}
										],
										expression: {
											argumentTypes: [
												{
													typeIdentifier: "t_uint256",
													typeString: "uint256"
												}
											],
											id: 2099,
											isConstant: false,
											isLValue: false,
											isPure: true,
											lValueRequested: false,
											nodeType: "ElementaryTypeNameExpression",
											src: "20525:6:2",
											typeDescriptions: {
												typeIdentifier: "t_type$_t_uint40_$",
												typeString: "type(uint40)"
											},
											typeName: "uint40"
										},
										id: 2101,
										isConstant: false,
										isLValue: false,
										isPure: false,
										kind: "typeConversion",
										lValueRequested: false,
										names: [
										],
										nodeType: "FunctionCall",
										src: "20525:11:2",
										typeDescriptions: {
											typeIdentifier: "t_uint40",
											typeString: "uint40"
										}
									},
									src: "20505:31:2",
									typeDescriptions: {
										typeIdentifier: "t_uint40",
										typeString: "uint40"
									}
								},
								id: 2103,
								nodeType: "ExpressionStatement",
								src: "20505:31:2"
							}
						]
					},
					documentation: null,
					id: 2105,
					implemented: true,
					kind: "function",
					modifiers: [
						{
							"arguments": null,
							id: 2096,
							modifierName: {
								argumentTypes: null,
								id: 2095,
								name: "onlyOwner",
								nodeType: "Identifier",
								overloadedDeclarations: [
								],
								referencedDeclaration: 5005,
								src: "20485:9:2",
								typeDescriptions: {
									typeIdentifier: "t_modifier$__$",
									typeString: "modifier ()"
								}
							},
							nodeType: "ModifierInvocation",
							src: "20485:9:2"
						}
					],
					name: "setGsnMaxCallsPerDay",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 2094,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 2093,
								name: "max",
								nodeType: "VariableDeclaration",
								scope: 2105,
								src: "20463:11:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_uint256",
									typeString: "uint256"
								},
								typeName: {
									id: 2092,
									name: "uint256",
									nodeType: "ElementaryTypeName",
									src: "20463:7:2",
									typeDescriptions: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "20462:13:2"
					},
					returnParameters: {
						id: 2097,
						nodeType: "ParameterList",
						parameters: [
						],
						src: "20495:0:2"
					},
					scope: 2289,
					src: "20433:110:2",
					stateMutability: "nonpayable",
					superFunction: null,
					visibility: "external"
				},
				{
					body: {
						id: 2127,
						nodeType: "Block",
						src: "20761:243:2",
						statements: [
							{
								assignments: [
									2109
								],
								declarations: [
									{
										constant: false,
										id: 2109,
										name: "curDateHashed",
										nodeType: "VariableDeclaration",
										scope: 2127,
										src: "20772:21:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_bytes32",
											typeString: "bytes32"
										},
										typeName: {
											id: 2108,
											name: "bytes32",
											nodeType: "ElementaryTypeName",
											src: "20772:7:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 2112,
								initialValue: {
									argumentTypes: null,
									"arguments": [
									],
									expression: {
										argumentTypes: [
										],
										id: 2110,
										name: "getGsnCounter",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 2187,
										src: "20796:13:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_view$__$returns$_t_bytes32_$",
											typeString: "function () view returns (bytes32)"
										}
									},
									id: 2111,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "20796:15:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "20772:39:2"
							},
							{
								assignments: [
									2114
								],
								declarations: [
									{
										constant: false,
										id: 2114,
										name: "curCounter",
										nodeType: "VariableDeclaration",
										scope: 2127,
										src: "20822:18:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										},
										typeName: {
											id: 2113,
											name: "uint256",
											nodeType: "ElementaryTypeName",
											src: "20822:7:2",
											typeDescriptions: {
												typeIdentifier: "t_uint256",
												typeString: "uint256"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 2118,
								initialValue: {
									argumentTypes: null,
									baseExpression: {
										argumentTypes: null,
										id: 2115,
										name: "gsnCounter",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 972,
										src: "20843:10:2",
										typeDescriptions: {
											typeIdentifier: "t_mapping$_t_bytes32_$_t_uint256_$",
											typeString: "mapping(bytes32 => uint256)"
										}
									},
									id: 2117,
									indexExpression: {
										argumentTypes: null,
										id: 2116,
										name: "curDateHashed",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 2109,
										src: "20854:13:2",
										typeDescriptions: {
											typeIdentifier: "t_bytes32",
											typeString: "bytes32"
										}
									},
									isConstant: false,
									isLValue: true,
									isPure: false,
									lValueRequested: false,
									nodeType: "IndexAccess",
									src: "20843:25:2",
									typeDescriptions: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "20822:46:2"
							},
							{
								expression: {
									argumentTypes: null,
									id: 2125,
									isConstant: false,
									isLValue: false,
									isPure: false,
									lValueRequested: false,
									leftHandSide: {
										argumentTypes: null,
										baseExpression: {
											argumentTypes: null,
											id: 2119,
											name: "gsnCounter",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 972,
											src: "20879:10:2",
											typeDescriptions: {
												typeIdentifier: "t_mapping$_t_bytes32_$_t_uint256_$",
												typeString: "mapping(bytes32 => uint256)"
											}
										},
										id: 2121,
										indexExpression: {
											argumentTypes: null,
											id: 2120,
											name: "curDateHashed",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 2109,
											src: "20890:13:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										isConstant: false,
										isLValue: true,
										isPure: false,
										lValueRequested: true,
										nodeType: "IndexAccess",
										src: "20879:25:2",
										typeDescriptions: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										}
									},
									nodeType: "Assignment",
									operator: "=",
									rightHandSide: {
										argumentTypes: null,
										commonType: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										},
										id: 2124,
										isConstant: false,
										isLValue: false,
										isPure: false,
										lValueRequested: false,
										leftExpression: {
											argumentTypes: null,
											id: 2122,
											name: "curCounter",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 2114,
											src: "20907:10:2",
											typeDescriptions: {
												typeIdentifier: "t_uint256",
												typeString: "uint256"
											}
										},
										nodeType: "BinaryOperation",
										operator: "+",
										rightExpression: {
											argumentTypes: null,
											hexValue: "31",
											id: 2123,
											isConstant: false,
											isLValue: false,
											isPure: true,
											kind: "number",
											lValueRequested: false,
											nodeType: "Literal",
											src: "20920:1:2",
											subdenomination: null,
											typeDescriptions: {
												typeIdentifier: "t_rational_1_by_1",
												typeString: "int_const 1"
											},
											value: "1"
										},
										src: "20907:14:2",
										typeDescriptions: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										}
									},
									src: "20879:42:2",
									typeDescriptions: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									}
								},
								id: 2126,
								nodeType: "ExpressionStatement",
								src: "20879:42:2"
							}
						]
					},
					documentation: "Increase the GSN Counter for today",
					id: 2128,
					implemented: true,
					kind: "function",
					modifiers: [
					],
					name: "increaseGsnCounter",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 2106,
						nodeType: "ParameterList",
						parameters: [
						],
						src: "20749:2:2"
					},
					returnParameters: {
						id: 2107,
						nodeType: "ParameterList",
						parameters: [
						],
						src: "20761:0:2"
					},
					scope: 2289,
					src: "20722:282:2",
					stateMutability: "nonpayable",
					superFunction: null,
					visibility: "internal"
				},
				{
					body: {
						id: 2186,
						nodeType: "Block",
						src: "21103:332:2",
						statements: [
							{
								assignments: [
									2134
								],
								declarations: [
									{
										constant: false,
										id: 2134,
										name: "curDate",
										nodeType: "VariableDeclaration",
										scope: 2186,
										src: "21114:15:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										},
										typeName: {
											id: 2133,
											name: "uint256",
											nodeType: "ElementaryTypeName",
											src: "21114:7:2",
											typeDescriptions: {
												typeIdentifier: "t_uint256",
												typeString: "uint256"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 2135,
								initialValue: null,
								nodeType: "VariableDeclarationStatement",
								src: "21114:15:2"
							},
							{
								assignments: [
									2137
								],
								declarations: [
									{
										constant: false,
										id: 2137,
										name: "year",
										nodeType: "VariableDeclaration",
										scope: 2186,
										src: "21140:11:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_uint16",
											typeString: "uint16"
										},
										typeName: {
											id: 2136,
											name: "uint16",
											nodeType: "ElementaryTypeName",
											src: "21140:6:2",
											typeDescriptions: {
												typeIdentifier: "t_uint16",
												typeString: "uint16"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 2142,
								initialValue: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 2140,
											name: "now",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 11010,
											src: "21171:3:2",
											typeDescriptions: {
												typeIdentifier: "t_uint256",
												typeString: "uint256"
											}
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_uint256",
												typeString: "uint256"
											}
										],
										expression: {
											argumentTypes: null,
											id: 2138,
											name: "dateTime",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 968,
											src: "21154:8:2",
											typeDescriptions: {
												typeIdentifier: "t_contract$_DateTime_$956",
												typeString: "contract DateTime"
											}
										},
										id: 2139,
										isConstant: false,
										isLValue: false,
										isPure: false,
										lValueRequested: false,
										memberName: "getYear",
										nodeType: "MemberAccess",
										referencedDeclaration: 941,
										src: "21154:16:2",
										typeDescriptions: {
											typeIdentifier: "t_function_external_pure$_t_uint256_$returns$_t_uint16_$",
											typeString: "function (uint256) pure external returns (uint16)"
										}
									},
									id: 2141,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "21154:21:2",
									typeDescriptions: {
										typeIdentifier: "t_uint16",
										typeString: "uint16"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "21140:35:2"
							},
							{
								assignments: [
									2144
								],
								declarations: [
									{
										constant: false,
										id: 2144,
										name: "month",
										nodeType: "VariableDeclaration",
										scope: 2186,
										src: "21185:11:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_uint8",
											typeString: "uint8"
										},
										typeName: {
											id: 2143,
											name: "uint8",
											nodeType: "ElementaryTypeName",
											src: "21185:5:2",
											typeDescriptions: {
												typeIdentifier: "t_uint8",
												typeString: "uint8"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 2149,
								initialValue: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 2147,
											name: "now",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 11010,
											src: "21217:3:2",
											typeDescriptions: {
												typeIdentifier: "t_uint256",
												typeString: "uint256"
											}
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_uint256",
												typeString: "uint256"
											}
										],
										expression: {
											argumentTypes: null,
											id: 2145,
											name: "dateTime",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 968,
											src: "21199:8:2",
											typeDescriptions: {
												typeIdentifier: "t_contract$_DateTime_$956",
												typeString: "contract DateTime"
											}
										},
										id: 2146,
										isConstant: false,
										isLValue: false,
										isPure: false,
										lValueRequested: false,
										memberName: "getMonth",
										nodeType: "MemberAccess",
										referencedDeclaration: 948,
										src: "21199:17:2",
										typeDescriptions: {
											typeIdentifier: "t_function_external_pure$_t_uint256_$returns$_t_uint8_$",
											typeString: "function (uint256) pure external returns (uint8)"
										}
									},
									id: 2148,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "21199:22:2",
									typeDescriptions: {
										typeIdentifier: "t_uint8",
										typeString: "uint8"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "21185:36:2"
							},
							{
								assignments: [
									2151
								],
								declarations: [
									{
										constant: false,
										id: 2151,
										name: "day",
										nodeType: "VariableDeclaration",
										scope: 2186,
										src: "21231:9:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_uint8",
											typeString: "uint8"
										},
										typeName: {
											id: 2150,
											name: "uint8",
											nodeType: "ElementaryTypeName",
											src: "21231:5:2",
											typeDescriptions: {
												typeIdentifier: "t_uint8",
												typeString: "uint8"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 2156,
								initialValue: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 2154,
											name: "now",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 11010,
											src: "21259:3:2",
											typeDescriptions: {
												typeIdentifier: "t_uint256",
												typeString: "uint256"
											}
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_uint256",
												typeString: "uint256"
											}
										],
										expression: {
											argumentTypes: null,
											id: 2152,
											name: "dateTime",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 968,
											src: "21243:8:2",
											typeDescriptions: {
												typeIdentifier: "t_contract$_DateTime_$956",
												typeString: "contract DateTime"
											}
										},
										id: 2153,
										isConstant: false,
										isLValue: false,
										isPure: false,
										lValueRequested: false,
										memberName: "getDay",
										nodeType: "MemberAccess",
										referencedDeclaration: 955,
										src: "21243:15:2",
										typeDescriptions: {
											typeIdentifier: "t_function_external_pure$_t_uint256_$returns$_t_uint8_$",
											typeString: "function (uint256) pure external returns (uint8)"
										}
									},
									id: 2155,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "21243:20:2",
									typeDescriptions: {
										typeIdentifier: "t_uint8",
										typeString: "uint8"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "21231:32:2"
							},
							{
								expression: {
									argumentTypes: null,
									id: 2159,
									isConstant: false,
									isLValue: false,
									isPure: false,
									lValueRequested: false,
									leftHandSide: {
										argumentTypes: null,
										id: 2157,
										name: "curDate",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 2134,
										src: "21274:7:2",
										typeDescriptions: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										}
									},
									nodeType: "Assignment",
									operator: "|=",
									rightHandSide: {
										argumentTypes: null,
										id: 2158,
										name: "year",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 2137,
										src: "21285:4:2",
										typeDescriptions: {
											typeIdentifier: "t_uint16",
											typeString: "uint16"
										}
									},
									src: "21274:15:2",
									typeDescriptions: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									}
								},
								id: 2160,
								nodeType: "ExpressionStatement",
								src: "21274:15:2"
							},
							{
								expression: {
									argumentTypes: null,
									id: 2167,
									isConstant: false,
									isLValue: false,
									isPure: false,
									lValueRequested: false,
									leftHandSide: {
										argumentTypes: null,
										id: 2161,
										name: "curDate",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 2134,
										src: "21299:7:2",
										typeDescriptions: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										}
									},
									nodeType: "Assignment",
									operator: "|=",
									rightHandSide: {
										argumentTypes: null,
										commonType: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										},
										id: 2166,
										isConstant: false,
										isLValue: false,
										isPure: false,
										lValueRequested: false,
										leftExpression: {
											argumentTypes: null,
											"arguments": [
												{
													argumentTypes: null,
													id: 2163,
													name: "month",
													nodeType: "Identifier",
													overloadedDeclarations: [
													],
													referencedDeclaration: 2144,
													src: "21318:5:2",
													typeDescriptions: {
														typeIdentifier: "t_uint8",
														typeString: "uint8"
													}
												}
											],
											expression: {
												argumentTypes: [
													{
														typeIdentifier: "t_uint8",
														typeString: "uint8"
													}
												],
												id: 2162,
												isConstant: false,
												isLValue: false,
												isPure: true,
												lValueRequested: false,
												nodeType: "ElementaryTypeNameExpression",
												src: "21310:7:2",
												typeDescriptions: {
													typeIdentifier: "t_type$_t_uint256_$",
													typeString: "type(uint256)"
												},
												typeName: "uint256"
											},
											id: 2164,
											isConstant: false,
											isLValue: false,
											isPure: false,
											kind: "typeConversion",
											lValueRequested: false,
											names: [
											],
											nodeType: "FunctionCall",
											src: "21310:14:2",
											typeDescriptions: {
												typeIdentifier: "t_uint256",
												typeString: "uint256"
											}
										},
										nodeType: "BinaryOperation",
										operator: "<<",
										rightExpression: {
											argumentTypes: null,
											hexValue: "3136",
											id: 2165,
											isConstant: false,
											isLValue: false,
											isPure: true,
											kind: "number",
											lValueRequested: false,
											nodeType: "Literal",
											src: "21326:2:2",
											subdenomination: null,
											typeDescriptions: {
												typeIdentifier: "t_rational_16_by_1",
												typeString: "int_const 16"
											},
											value: "16"
										},
										src: "21310:18:2",
										typeDescriptions: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										}
									},
									src: "21299:29:2",
									typeDescriptions: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									}
								},
								id: 2168,
								nodeType: "ExpressionStatement",
								src: "21299:29:2"
							},
							{
								expression: {
									argumentTypes: null,
									id: 2175,
									isConstant: false,
									isLValue: false,
									isPure: false,
									lValueRequested: false,
									leftHandSide: {
										argumentTypes: null,
										id: 2169,
										name: "curDate",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 2134,
										src: "21338:7:2",
										typeDescriptions: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										}
									},
									nodeType: "Assignment",
									operator: "|=",
									rightHandSide: {
										argumentTypes: null,
										commonType: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										},
										id: 2174,
										isConstant: false,
										isLValue: false,
										isPure: false,
										lValueRequested: false,
										leftExpression: {
											argumentTypes: null,
											"arguments": [
												{
													argumentTypes: null,
													id: 2171,
													name: "day",
													nodeType: "Identifier",
													overloadedDeclarations: [
													],
													referencedDeclaration: 2151,
													src: "21357:3:2",
													typeDescriptions: {
														typeIdentifier: "t_uint8",
														typeString: "uint8"
													}
												}
											],
											expression: {
												argumentTypes: [
													{
														typeIdentifier: "t_uint8",
														typeString: "uint8"
													}
												],
												id: 2170,
												isConstant: false,
												isLValue: false,
												isPure: true,
												lValueRequested: false,
												nodeType: "ElementaryTypeNameExpression",
												src: "21349:7:2",
												typeDescriptions: {
													typeIdentifier: "t_type$_t_uint256_$",
													typeString: "type(uint256)"
												},
												typeName: "uint256"
											},
											id: 2172,
											isConstant: false,
											isLValue: false,
											isPure: false,
											kind: "typeConversion",
											lValueRequested: false,
											names: [
											],
											nodeType: "FunctionCall",
											src: "21349:12:2",
											typeDescriptions: {
												typeIdentifier: "t_uint256",
												typeString: "uint256"
											}
										},
										nodeType: "BinaryOperation",
										operator: "<<",
										rightExpression: {
											argumentTypes: null,
											hexValue: "3234",
											id: 2173,
											isConstant: false,
											isLValue: false,
											isPure: true,
											kind: "number",
											lValueRequested: false,
											nodeType: "Literal",
											src: "21363:2:2",
											subdenomination: null,
											typeDescriptions: {
												typeIdentifier: "t_rational_24_by_1",
												typeString: "int_const 24"
											},
											value: "24"
										},
										src: "21349:16:2",
										typeDescriptions: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										}
									},
									src: "21338:27:2",
									typeDescriptions: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									}
								},
								id: 2176,
								nodeType: "ExpressionStatement",
								src: "21338:27:2"
							},
							{
								expression: {
									argumentTypes: null,
									id: 2184,
									isConstant: false,
									isLValue: false,
									isPure: false,
									lValueRequested: false,
									leftHandSide: {
										argumentTypes: null,
										id: 2177,
										name: "curDateHashed",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 2131,
										src: "21376:13:2",
										typeDescriptions: {
											typeIdentifier: "t_bytes32",
											typeString: "bytes32"
										}
									},
									nodeType: "Assignment",
									operator: "=",
									rightHandSide: {
										argumentTypes: null,
										"arguments": [
											{
												argumentTypes: null,
												"arguments": [
													{
														argumentTypes: null,
														id: 2181,
														name: "curDate",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 2134,
														src: "21419:7:2",
														typeDescriptions: {
															typeIdentifier: "t_uint256",
															typeString: "uint256"
														}
													}
												],
												expression: {
													argumentTypes: [
														{
															typeIdentifier: "t_uint256",
															typeString: "uint256"
														}
													],
													expression: {
														argumentTypes: null,
														id: 2179,
														name: "abi",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 10995,
														src: "21402:3:2",
														typeDescriptions: {
															typeIdentifier: "t_magic_abi",
															typeString: "abi"
														}
													},
													id: 2180,
													isConstant: false,
													isLValue: false,
													isPure: true,
													lValueRequested: false,
													memberName: "encodePacked",
													nodeType: "MemberAccess",
													referencedDeclaration: null,
													src: "21402:16:2",
													typeDescriptions: {
														typeIdentifier: "t_function_abiencodepacked_pure$__$returns$_t_bytes_memory_ptr_$",
														typeString: "function () pure returns (bytes memory)"
													}
												},
												id: 2182,
												isConstant: false,
												isLValue: false,
												isPure: false,
												kind: "functionCall",
												lValueRequested: false,
												names: [
												],
												nodeType: "FunctionCall",
												src: "21402:25:2",
												typeDescriptions: {
													typeIdentifier: "t_bytes_memory_ptr",
													typeString: "bytes memory"
												}
											}
										],
										expression: {
											argumentTypes: [
												{
													typeIdentifier: "t_bytes_memory_ptr",
													typeString: "bytes memory"
												}
											],
											id: 2178,
											name: "keccak256",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 11002,
											src: "21392:9:2",
											typeDescriptions: {
												typeIdentifier: "t_function_keccak256_pure$_t_bytes_memory_ptr_$returns$_t_bytes32_$",
												typeString: "function (bytes memory) pure returns (bytes32)"
											}
										},
										id: 2183,
										isConstant: false,
										isLValue: false,
										isPure: false,
										kind: "functionCall",
										lValueRequested: false,
										names: [
										],
										nodeType: "FunctionCall",
										src: "21392:36:2",
										typeDescriptions: {
											typeIdentifier: "t_bytes32",
											typeString: "bytes32"
										}
									},
									src: "21376:52:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								id: 2185,
								nodeType: "ExpressionStatement",
								src: "21376:52:2"
							}
						]
					},
					documentation: null,
					id: 2187,
					implemented: true,
					kind: "function",
					modifiers: [
					],
					name: "getGsnCounter",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 2129,
						nodeType: "ParameterList",
						parameters: [
						],
						src: "21054:2:2"
					},
					returnParameters: {
						id: 2132,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 2131,
								name: "curDateHashed",
								nodeType: "VariableDeclaration",
								scope: 2187,
								src: "21080:21:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 2130,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "21080:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "21079:23:2"
					},
					scope: 2289,
					src: "21032:403:2",
					stateMutability: "view",
					superFunction: null,
					visibility: "internal"
				},
				{
					body: {
						id: 2194,
						nodeType: "Block",
						src: "21614:7:2",
						statements: [
						]
					},
					documentation: null,
					id: 2195,
					implemented: true,
					kind: "function",
					modifiers: [
					],
					name: "_preRelayedCall",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 2190,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 2189,
								name: "context",
								nodeType: "VariableDeclaration",
								scope: 2195,
								src: "21565:20:2",
								stateVariable: false,
								storageLocation: "memory",
								typeDescriptions: {
									typeIdentifier: "t_bytes_memory_ptr",
									typeString: "bytes"
								},
								typeName: {
									id: 2188,
									name: "bytes",
									nodeType: "ElementaryTypeName",
									src: "21565:5:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes_storage_ptr",
										typeString: "bytes"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "21564:22:2"
					},
					returnParameters: {
						id: 2193,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 2192,
								name: "",
								nodeType: "VariableDeclaration",
								scope: 2195,
								src: "21605:7:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 2191,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "21605:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "21604:9:2"
					},
					scope: 2289,
					src: "21540:81:2",
					stateMutability: "nonpayable",
					superFunction: 4172,
					visibility: "internal"
				},
				{
					body: {
						id: 2206,
						nodeType: "Block",
						src: "21721:7:2",
						statements: [
						]
					},
					documentation: null,
					id: 2207,
					implemented: true,
					kind: "function",
					modifiers: [
					],
					name: "_postRelayedCall",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 2204,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 2197,
								name: "context",
								nodeType: "VariableDeclaration",
								scope: 2207,
								src: "21653:20:2",
								stateVariable: false,
								storageLocation: "memory",
								typeDescriptions: {
									typeIdentifier: "t_bytes_memory_ptr",
									typeString: "bytes"
								},
								typeName: {
									id: 2196,
									name: "bytes",
									nodeType: "ElementaryTypeName",
									src: "21653:5:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes_storage_ptr",
										typeString: "bytes"
									}
								},
								value: null,
								visibility: "internal"
							},
							{
								constant: false,
								id: 2199,
								name: "",
								nodeType: "VariableDeclaration",
								scope: 2207,
								src: "21675:4:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bool",
									typeString: "bool"
								},
								typeName: {
									id: 2198,
									name: "bool",
									nodeType: "ElementaryTypeName",
									src: "21675:4:2",
									typeDescriptions: {
										typeIdentifier: "t_bool",
										typeString: "bool"
									}
								},
								value: null,
								visibility: "internal"
							},
							{
								constant: false,
								id: 2201,
								name: "actualCharge",
								nodeType: "VariableDeclaration",
								scope: 2207,
								src: "21681:20:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_uint256",
									typeString: "uint256"
								},
								typeName: {
									id: 2200,
									name: "uint256",
									nodeType: "ElementaryTypeName",
									src: "21681:7:2",
									typeDescriptions: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									}
								},
								value: null,
								visibility: "internal"
							},
							{
								constant: false,
								id: 2203,
								name: "",
								nodeType: "VariableDeclaration",
								scope: 2207,
								src: "21703:7:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 2202,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "21703:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "21652:59:2"
					},
					returnParameters: {
						id: 2205,
						nodeType: "ParameterList",
						parameters: [
						],
						src: "21721:0:2"
					},
					scope: 2289,
					src: "21627:101:2",
					stateMutability: "nonpayable",
					superFunction: 4184,
					visibility: "internal"
				},
				{
					body: {
						id: 2228,
						nodeType: "Block",
						src: "22002:92:2",
						statements: [
							{
								assignments: [
									2217
								],
								declarations: [
									{
										constant: false,
										id: 2217,
										name: "relayHub",
										nodeType: "VariableDeclaration",
										scope: 2228,
										src: "22012:21:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_contract$_IRelayHubELA_$4008",
											typeString: "contract IRelayHubELA"
										},
										typeName: {
											contractScope: null,
											id: 2216,
											name: "IRelayHubELA",
											nodeType: "UserDefinedTypeName",
											referencedDeclaration: 4008,
											src: "22012:12:2",
											typeDescriptions: {
												typeIdentifier: "t_contract$_IRelayHubELA_$4008",
												typeString: "contract IRelayHubELA"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 2220,
								initialValue: {
									argumentTypes: null,
									"arguments": [
									],
									expression: {
										argumentTypes: [
										],
										id: 2218,
										name: "getRelayHub",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 2288,
										src: "22036:11:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_view$__$returns$_t_contract$_IRelayHubELA_$4008_$",
											typeString: "function () view returns (contract IRelayHubELA)"
										}
									},
									id: 2219,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "22036:13:2",
									typeDescriptions: {
										typeIdentifier: "t_contract$_IRelayHubELA_$4008",
										typeString: "contract IRelayHubELA"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "22012:37:2"
							},
							{
								expression: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 2224,
											name: "amt",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 2209,
											src: "22077:3:2",
											typeDescriptions: {
												typeIdentifier: "t_uint256",
												typeString: "uint256"
											}
										},
										{
											argumentTypes: null,
											id: 2225,
											name: "dest",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 2211,
											src: "22082:4:2",
											typeDescriptions: {
												typeIdentifier: "t_address_payable",
												typeString: "address payable"
											}
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_uint256",
												typeString: "uint256"
											},
											{
												typeIdentifier: "t_address_payable",
												typeString: "address payable"
											}
										],
										expression: {
											argumentTypes: null,
											id: 2221,
											name: "relayHub",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 2217,
											src: "22059:8:2",
											typeDescriptions: {
												typeIdentifier: "t_contract$_IRelayHubELA_$4008",
												typeString: "contract IRelayHubELA"
											}
										},
										id: 2223,
										isConstant: false,
										isLValue: false,
										isPure: false,
										lValueRequested: false,
										memberName: "withdraw",
										nodeType: "MemberAccess",
										referencedDeclaration: 3862,
										src: "22059:17:2",
										typeDescriptions: {
											typeIdentifier: "t_function_external_nonpayable$_t_uint256_$_t_address_payable_$returns$__$",
											typeString: "function (uint256,address payable) external"
										}
									},
									id: 2226,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "22059:28:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 2227,
								nodeType: "ExpressionStatement",
								src: "22059:28:2"
							}
						]
					},
					documentation: "@dev Withdraw a specific amount of the GSNReceipient funds\n@param amt Amount of wei to withdraw\n@param dest This is the arbitrary withdrawal destination address",
					id: 2229,
					implemented: true,
					kind: "function",
					modifiers: [
						{
							"arguments": null,
							id: 2214,
							modifierName: {
								argumentTypes: null,
								id: 2213,
								name: "onlyOwner",
								nodeType: "Identifier",
								overloadedDeclarations: [
								],
								referencedDeclaration: 5005,
								src: "21992:9:2",
								typeDescriptions: {
									typeIdentifier: "t_modifier$__$",
									typeString: "modifier ()"
								}
							},
							nodeType: "ModifierInvocation",
							src: "21992:9:2"
						}
					],
					name: "withdraw",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 2212,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 2209,
								name: "amt",
								nodeType: "VariableDeclaration",
								scope: 2229,
								src: "21950:11:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_uint256",
									typeString: "uint256"
								},
								typeName: {
									id: 2208,
									name: "uint256",
									nodeType: "ElementaryTypeName",
									src: "21950:7:2",
									typeDescriptions: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									}
								},
								value: null,
								visibility: "internal"
							},
							{
								constant: false,
								id: 2211,
								name: "dest",
								nodeType: "VariableDeclaration",
								scope: 2229,
								src: "21963:20:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_address_payable",
									typeString: "address payable"
								},
								typeName: {
									id: 2210,
									name: "address",
									nodeType: "ElementaryTypeName",
									src: "21963:15:2",
									stateMutability: "payable",
									typeDescriptions: {
										typeIdentifier: "t_address_payable",
										typeString: "address payable"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "21949:35:2"
					},
					returnParameters: {
						id: 2215,
						nodeType: "ParameterList",
						parameters: [
						],
						src: "22002:0:2"
					},
					scope: 2289,
					src: "21932:162:2",
					stateMutability: "nonpayable",
					superFunction: null,
					visibility: "public"
				},
				{
					body: {
						id: 2262,
						nodeType: "Block",
						src: "22315:186:2",
						statements: [
							{
								assignments: [
									2239
								],
								declarations: [
									{
										constant: false,
										id: 2239,
										name: "relayHub",
										nodeType: "VariableDeclaration",
										scope: 2262,
										src: "22325:21:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_contract$_IRelayHubELA_$4008",
											typeString: "contract IRelayHubELA"
										},
										typeName: {
											contractScope: null,
											id: 2238,
											name: "IRelayHubELA",
											nodeType: "UserDefinedTypeName",
											referencedDeclaration: 4008,
											src: "22325:12:2",
											typeDescriptions: {
												typeIdentifier: "t_contract$_IRelayHubELA_$4008",
												typeString: "contract IRelayHubELA"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 2242,
								initialValue: {
									argumentTypes: null,
									"arguments": [
									],
									expression: {
										argumentTypes: [
										],
										id: 2240,
										name: "getRelayHub",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 2288,
										src: "22349:11:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_view$__$returns$_t_contract$_IRelayHubELA_$4008_$",
											typeString: "function () view returns (contract IRelayHubELA)"
										}
									},
									id: 2241,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "22349:13:2",
									typeDescriptions: {
										typeIdentifier: "t_contract$_IRelayHubELA_$4008",
										typeString: "contract IRelayHubELA"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "22325:37:2"
							},
							{
								assignments: [
									2244
								],
								declarations: [
									{
										constant: false,
										id: 2244,
										name: "balance",
										nodeType: "VariableDeclaration",
										scope: 2262,
										src: "22372:15:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										},
										typeName: {
											id: 2243,
											name: "uint256",
											nodeType: "ElementaryTypeName",
											src: "22372:7:2",
											typeDescriptions: {
												typeIdentifier: "t_uint256",
												typeString: "uint256"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 2252,
								initialValue: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											"arguments": [
												{
													argumentTypes: null,
													id: 2249,
													name: "this",
													nodeType: "Identifier",
													overloadedDeclarations: [
													],
													referencedDeclaration: 11067,
													src: "22422:4:2",
													typeDescriptions: {
														typeIdentifier: "t_contract$_ELAJSStore_$2289",
														typeString: "contract ELAJSStore"
													}
												}
											],
											expression: {
												argumentTypes: [
													{
														typeIdentifier: "t_contract$_ELAJSStore_$2289",
														typeString: "contract ELAJSStore"
													}
												],
												id: 2248,
												isConstant: false,
												isLValue: false,
												isPure: true,
												lValueRequested: false,
												nodeType: "ElementaryTypeNameExpression",
												src: "22414:7:2",
												typeDescriptions: {
													typeIdentifier: "t_type$_t_address_$",
													typeString: "type(address)"
												},
												typeName: "address"
											},
											id: 2250,
											isConstant: false,
											isLValue: false,
											isPure: false,
											kind: "typeConversion",
											lValueRequested: false,
											names: [
											],
											nodeType: "FunctionCall",
											src: "22414:13:2",
											typeDescriptions: {
												typeIdentifier: "t_address_payable",
												typeString: "address payable"
											}
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_address_payable",
												typeString: "address payable"
											}
										],
										expression: {
											argumentTypes: null,
											"arguments": [
											],
											expression: {
												argumentTypes: [
												],
												id: 2245,
												name: "getRelayHub",
												nodeType: "Identifier",
												overloadedDeclarations: [
												],
												referencedDeclaration: 2288,
												src: "22390:11:2",
												typeDescriptions: {
													typeIdentifier: "t_function_internal_view$__$returns$_t_contract$_IRelayHubELA_$4008_$",
													typeString: "function () view returns (contract IRelayHubELA)"
												}
											},
											id: 2246,
											isConstant: false,
											isLValue: false,
											isPure: false,
											kind: "functionCall",
											lValueRequested: false,
											names: [
											],
											nodeType: "FunctionCall",
											src: "22390:13:2",
											typeDescriptions: {
												typeIdentifier: "t_contract$_IRelayHubELA_$4008",
												typeString: "contract IRelayHubELA"
											}
										},
										id: 2247,
										isConstant: false,
										isLValue: false,
										isPure: false,
										lValueRequested: false,
										memberName: "balanceOf",
										nodeType: "MemberAccess",
										referencedDeclaration: 3855,
										src: "22390:23:2",
										typeDescriptions: {
											typeIdentifier: "t_function_external_view$_t_address_$returns$_t_uint256_$",
											typeString: "function (address) view external returns (uint256)"
										}
									},
									id: 2251,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "22390:38:2",
									typeDescriptions: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "22372:56:2"
							},
							{
								expression: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 2256,
											name: "balance",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 2244,
											src: "22456:7:2",
											typeDescriptions: {
												typeIdentifier: "t_uint256",
												typeString: "uint256"
											}
										},
										{
											argumentTypes: null,
											id: 2257,
											name: "dest",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 2231,
											src: "22465:4:2",
											typeDescriptions: {
												typeIdentifier: "t_address_payable",
												typeString: "address payable"
											}
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_uint256",
												typeString: "uint256"
											},
											{
												typeIdentifier: "t_address_payable",
												typeString: "address payable"
											}
										],
										expression: {
											argumentTypes: null,
											id: 2253,
											name: "relayHub",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 2239,
											src: "22438:8:2",
											typeDescriptions: {
												typeIdentifier: "t_contract$_IRelayHubELA_$4008",
												typeString: "contract IRelayHubELA"
											}
										},
										id: 2255,
										isConstant: false,
										isLValue: false,
										isPure: false,
										lValueRequested: false,
										memberName: "withdraw",
										nodeType: "MemberAccess",
										referencedDeclaration: 3862,
										src: "22438:17:2",
										typeDescriptions: {
											typeIdentifier: "t_function_external_nonpayable$_t_uint256_$_t_address_payable_$returns$__$",
											typeString: "function (uint256,address payable) external"
										}
									},
									id: 2258,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "22438:32:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 2259,
								nodeType: "ExpressionStatement",
								src: "22438:32:2"
							},
							{
								expression: {
									argumentTypes: null,
									id: 2260,
									name: "balance",
									nodeType: "Identifier",
									overloadedDeclarations: [
									],
									referencedDeclaration: 2244,
									src: "22487:7:2",
									typeDescriptions: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									}
								},
								functionReturnParameters: 2237,
								id: 2261,
								nodeType: "Return",
								src: "22480:14:2"
							}
						]
					},
					documentation: "@dev Withdraw all the GSNReceipient funds\n@param dest This is the arbitrary withdrawal destination address",
					id: 2263,
					implemented: true,
					kind: "function",
					modifiers: [
						{
							"arguments": null,
							id: 2234,
							modifierName: {
								argumentTypes: null,
								id: 2233,
								name: "onlyOwner",
								nodeType: "Identifier",
								overloadedDeclarations: [
								],
								referencedDeclaration: 5005,
								src: "22287:9:2",
								typeDescriptions: {
									typeIdentifier: "t_modifier$__$",
									typeString: "modifier ()"
								}
							},
							nodeType: "ModifierInvocation",
							src: "22287:9:2"
						}
					],
					name: "withdrawAll",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 2232,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 2231,
								name: "dest",
								nodeType: "VariableDeclaration",
								scope: 2263,
								src: "22258:20:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_address_payable",
									typeString: "address payable"
								},
								typeName: {
									id: 2230,
									name: "address",
									nodeType: "ElementaryTypeName",
									src: "22258:15:2",
									stateMutability: "payable",
									typeDescriptions: {
										typeIdentifier: "t_address_payable",
										typeString: "address payable"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "22257:22:2"
					},
					returnParameters: {
						id: 2237,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 2236,
								name: "",
								nodeType: "VariableDeclaration",
								scope: 2263,
								src: "22306:7:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_uint256",
									typeString: "uint256"
								},
								typeName: {
									id: 2235,
									name: "uint256",
									nodeType: "ElementaryTypeName",
									src: "22306:7:2",
									typeDescriptions: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "22305:9:2"
					},
					scope: 2289,
					src: "22237:264:2",
					stateMutability: "nonpayable",
					superFunction: null,
					visibility: "public"
				},
				{
					body: {
						id: 2276,
						nodeType: "Block",
						src: "22562:62:2",
						statements: [
							{
								expression: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											"arguments": [
												{
													argumentTypes: null,
													id: 2272,
													name: "this",
													nodeType: "Identifier",
													overloadedDeclarations: [
													],
													referencedDeclaration: 11067,
													src: "22611:4:2",
													typeDescriptions: {
														typeIdentifier: "t_contract$_ELAJSStore_$2289",
														typeString: "contract ELAJSStore"
													}
												}
											],
											expression: {
												argumentTypes: [
													{
														typeIdentifier: "t_contract$_ELAJSStore_$2289",
														typeString: "contract ELAJSStore"
													}
												],
												id: 2271,
												isConstant: false,
												isLValue: false,
												isPure: true,
												lValueRequested: false,
												nodeType: "ElementaryTypeNameExpression",
												src: "22603:7:2",
												typeDescriptions: {
													typeIdentifier: "t_type$_t_address_$",
													typeString: "type(address)"
												},
												typeName: "address"
											},
											id: 2273,
											isConstant: false,
											isLValue: false,
											isPure: false,
											kind: "typeConversion",
											lValueRequested: false,
											names: [
											],
											nodeType: "FunctionCall",
											src: "22603:13:2",
											typeDescriptions: {
												typeIdentifier: "t_address_payable",
												typeString: "address payable"
											}
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_address_payable",
												typeString: "address payable"
											}
										],
										expression: {
											argumentTypes: null,
											"arguments": [
											],
											expression: {
												argumentTypes: [
												],
												id: 2268,
												name: "getRelayHub",
												nodeType: "Identifier",
												overloadedDeclarations: [
												],
												referencedDeclaration: 2288,
												src: "22579:11:2",
												typeDescriptions: {
													typeIdentifier: "t_function_internal_view$__$returns$_t_contract$_IRelayHubELA_$4008_$",
													typeString: "function () view returns (contract IRelayHubELA)"
												}
											},
											id: 2269,
											isConstant: false,
											isLValue: false,
											isPure: false,
											kind: "functionCall",
											lValueRequested: false,
											names: [
											],
											nodeType: "FunctionCall",
											src: "22579:13:2",
											typeDescriptions: {
												typeIdentifier: "t_contract$_IRelayHubELA_$4008",
												typeString: "contract IRelayHubELA"
											}
										},
										id: 2270,
										isConstant: false,
										isLValue: false,
										isPure: false,
										lValueRequested: false,
										memberName: "balanceOf",
										nodeType: "MemberAccess",
										referencedDeclaration: 3855,
										src: "22579:23:2",
										typeDescriptions: {
											typeIdentifier: "t_function_external_view$_t_address_$returns$_t_uint256_$",
											typeString: "function (address) view external returns (uint256)"
										}
									},
									id: 2274,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "22579:38:2",
									typeDescriptions: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									}
								},
								functionReturnParameters: 2267,
								id: 2275,
								nodeType: "Return",
								src: "22572:45:2"
							}
						]
					},
					documentation: null,
					id: 2277,
					implemented: true,
					kind: "function",
					modifiers: [
					],
					name: "getGSNBalance",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 2264,
						nodeType: "ParameterList",
						parameters: [
						],
						src: "22529:2:2"
					},
					returnParameters: {
						id: 2267,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 2266,
								name: "",
								nodeType: "VariableDeclaration",
								scope: 2277,
								src: "22553:7:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_uint256",
									typeString: "uint256"
								},
								typeName: {
									id: 2265,
									name: "uint256",
									nodeType: "ElementaryTypeName",
									src: "22553:7:2",
									typeDescriptions: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "22552:9:2"
					},
					scope: 2289,
					src: "22507:117:2",
					stateMutability: "view",
					superFunction: null,
					visibility: "public"
				},
				{
					body: {
						id: 2287,
						nodeType: "Block",
						src: "22690:52:2",
						statements: [
							{
								expression: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											"arguments": [
											],
											expression: {
												argumentTypes: [
												],
												id: 2283,
												name: "_getRelayHub",
												nodeType: "Identifier",
												overloadedDeclarations: [
												],
												referencedDeclaration: 3550,
												src: "22720:12:2",
												typeDescriptions: {
													typeIdentifier: "t_function_internal_view$__$returns$_t_address_$",
													typeString: "function () view returns (address)"
												}
											},
											id: 2284,
											isConstant: false,
											isLValue: false,
											isPure: false,
											kind: "functionCall",
											lValueRequested: false,
											names: [
											],
											nodeType: "FunctionCall",
											src: "22720:14:2",
											typeDescriptions: {
												typeIdentifier: "t_address",
												typeString: "address"
											}
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_address",
												typeString: "address"
											}
										],
										id: 2282,
										name: "IRelayHubELA",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 4008,
										src: "22707:12:2",
										typeDescriptions: {
											typeIdentifier: "t_type$_t_contract$_IRelayHubELA_$4008_$",
											typeString: "type(contract IRelayHubELA)"
										}
									},
									id: 2285,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "typeConversion",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "22707:28:2",
									typeDescriptions: {
										typeIdentifier: "t_contract$_IRelayHubELA_$4008",
										typeString: "contract IRelayHubELA"
									}
								},
								functionReturnParameters: 2281,
								id: 2286,
								nodeType: "Return",
								src: "22700:35:2"
							}
						]
					},
					documentation: null,
					id: 2288,
					implemented: true,
					kind: "function",
					modifiers: [
					],
					name: "getRelayHub",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 2278,
						nodeType: "ParameterList",
						parameters: [
						],
						src: "22650:2:2"
					},
					returnParameters: {
						id: 2281,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 2280,
								name: "",
								nodeType: "VariableDeclaration",
								scope: 2288,
								src: "22676:12:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_contract$_IRelayHubELA_$4008",
									typeString: "contract IRelayHubELA"
								},
								typeName: {
									contractScope: null,
									id: 2279,
									name: "IRelayHubELA",
									nodeType: "UserDefinedTypeName",
									referencedDeclaration: 4008,
									src: "22676:12:2",
									typeDescriptions: {
										typeIdentifier: "t_contract$_IRelayHubELA_$4008",
										typeString: "contract IRelayHubELA"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "22675:14:2"
					},
					scope: 2289,
					src: "22630:112:2",
					stateMutability: "view",
					superFunction: null,
					visibility: "internal"
				}
			],
			scope: 2290,
			src: "782:21962:2"
		}
	],
	src: "0:22745:2"
};
var bytecode = "0x608060405273e982e462b094850f12af94d21d470e21be9d0e9c606660006101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff160217905550606660009054906101000a900473ffffffffffffffffffffffffffffffffffffffff16606760006101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff160217905550615e0a806100cb6000396000f3fe6080604052600436106101b6576000357c0100000000000000000000000000000000000000000000000000000000900463ffffffff168062f714ce146101b857806301ee810a146101e15780631fd6dda51461020c57806328343c3414610249578063287e724614610274578063365628a2146102b25780633c2e8599146102db5780633ffe300e146103065780634102fbf61461032f57806359cb73a41461035a5780636729003c14610397578063715018a6146103d457806374e861d6146103eb5780637e03a8241461041657806380274db71461043f5780638129fc1c1461047c5780638175d7eb1461049357806383947ea0146104bc5780638d3178cc146104fa5780638da5cb5b146105235780638f32d59b1461054e578063a2ea7c6e14610579578063ad61ccd5146105b6578063b467949b146105e1578063bc41c3dd1461060a578063c2309bf914610633578063c4d66de814610670578063d2c5ce3114610699578063d887f105146106c4578063e06e0e2214610702578063e3c504e41461072b578063ed90cb3714610768578063f201fe2a14610791578063f2fde38b146107ce578063fa09e630146107f7575b005b3480156101c457600080fd5b506101df60048036036101da9190810190614ca3565b610834565b005b3480156101ed57600080fd5b506101f6610916565b6040516102039190615b4b565b60405180910390f35b34801561021857600080fd5b50610233600480360361022e919081019061489f565b61092d565b60405161024091906156b2565b60405180910390f35b34801561025557600080fd5b5061025e61094a565b60405161026b9190615690565b60405180910390f35b34801561028057600080fd5b5061029b6004803603610296919081019061489f565b610988565b6040516102a9929190615667565b60405180910390f35b3480156102be57600080fd5b506102d960048036036102d49190810190614abc565b6109de565b005b3480156102e757600080fd5b506102f0610b0a565b6040516102fd9190615aae565b60405180910390f35b34801561031257600080fd5b5061032d60048036036103289190810190614a2d565b610bbd565b005b34801561033b57600080fd5b50610344610d91565b60405161035191906156cd565b60405180910390f35b34801561036657600080fd5b50610381600480360361037c919081019061489f565b610db8565b60405161038e9190615aae565b60405180910390f35b3480156103a357600080fd5b506103be60048036036103b9919081019061489f565b610dd0565b6040516103cb91906156cd565b60405180910390f35b3480156103e057600080fd5b506103e9610e13565b005b3480156103f757600080fd5b50610400610f1d565b60405161040d9190615631565b60405180910390f35b34801561042257600080fd5b5061043d600480360361043891908101906149b6565b610f2c565b005b34801561044b57600080fd5b5061046660048036036104619190810190614b63565b610f7c565b60405161047391906156cd565b60405180910390f35b34801561048857600080fd5b5061049161104a565b005b34801561049f57600080fd5b506104ba60048036036104b59190810190614904565b61114e565b005b3480156104c857600080fd5b506104e360048036036104de919081019061479f565b61118d565b6040516104f1929190615b1b565b60405180910390f35b34801561050657600080fd5b50610521600480360361051c9190810190614953565b61120c565b005b34801561052f57600080fd5b506105386112a6565b6040516105459190615631565b60405180910390f35b34801561055a57600080fd5b506105636112d0565b60405161057091906156b2565b60405180910390f35b34801561058557600080fd5b506105a0600480360361059b919081019061489f565b61132f565b6040516105ad9190615a8c565b60405180910390f35b3480156105c257600080fd5b506105cb611360565b6040516105d8919061570a565b60405180910390f35b3480156105ed57600080fd5b50610608600480360361060391908101906149b6565b61139d565b005b34801561061657600080fd5b50610631600480360361062c9190810190614c51565b611571565b005b34801561063f57600080fd5b5061065a6004803603610655919081019061489f565b6115e0565b6040516106679190615690565b60405180910390f35b34801561067c57600080fd5b506106976004803603610692919081019061474d565b611659565b005b3480156106a557600080fd5b506106ae611803565b6040516106bb9190615631565b60405180910390f35b3480156106d057600080fd5b506106eb60048036036106e6919081019061489f565b611829565b6040516106f9929190615ac9565b60405180910390f35b34801561070e57600080fd5b5061072960048036036107249190810190614ba8565b6118be565b005b34801561073757600080fd5b50610752600480360361074d919081019061489f565b61198c565b60405161075f91906156e8565b60405180910390f35b34801561077457600080fd5b5061078f600480360361078a91908101906148c8565b6119ff565b005b34801561079d57600080fd5b506107b860048036036107b391908101906148c8565b611ab7565b6040516107c591906156b2565b60405180910390f35b3480156107da57600080fd5b506107f560048036036107f0919081019061474d565b611ad7565b005b34801561080357600080fd5b5061081e60048036036108199190810190614776565b611b2c565b60405161082b9190615aae565b60405180910390f35b61083c6112d0565b151561087d576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401610874906158ec565b60405180910390fd5b6000610887611cc5565b90508073ffffffffffffffffffffffffffffffffffffffff1662f714ce84846040518363ffffffff167c01000000000000000000000000000000000000000000000000000000000281526004016108df929190615af2565b600060405180830381600087803b1580156108f957600080fd5b505af115801561090d573d6000803e3d6000fd5b50505050505050565b606960009054906101000a900464ffffffffff1681565b600061094382606e611cd490919063ffffffff16565b9050919050565b60606109837f736368656d61732e7075626c69632e7461626c65730000000000000000000000600102606e611d4b90919063ffffffff16565b905090565b60008060006109a184606e611d6b90919063ffffffff16565b600190049050807c0100000000000000000000000000000000000000000000000000000000029150602081908060020a8204915050925050915091565b6109e66112d0565b1515610a27576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401610a1e906158ec565b60405180910390fd5b6000600102606a600086815260200190815260200160002054141515610a82576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401610a79906159ac565b60405180910390fd5b6000809050610a92858583611d8b565b610acb7f736368656d61732e7075626c69632e7461626c6573000000000000000000000060010287606e611e379092919063ffffffff16565b50610ae085606b611f6290919063ffffffff16565b50610ae9614428565b610af4878585611f82565b9050610b008682611fff565b5050505050505050565b6000610b14611cc5565b73ffffffffffffffffffffffffffffffffffffffff166370a08231306040518263ffffffff167c0100000000000000000000000000000000000000000000000000000000028152600401610b68919061564c565b60206040518083038186803b158015610b8057600080fd5b505afa158015610b94573d6000803e3d6000fd5b505050506040513d601f19601f82011682018060405250610bb89190810190614c7a565b905090565b84600080610bca83611829565b91509150600082111515610c13576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401610c0a906157cc565b60405180910390fd5b6001821180610c2d575060011515610c296112d0565b1515145b80610c6a5750610c3b61202d565b73ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff16145b1515610cab576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401610ca2906158ac565b60405180910390fd5b6000610cb7888a612081565b90506000610cc58883612081565b905060001515610cdf82606e611cd490919063ffffffff16565b1515141515610d23576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401610d1a9061592c565b60405180910390fd5b610d2b6120de565b610d418a88606b6121219092919063ffffffff16565b5060001515610d5a83606e611cd490919063ffffffff16565b15151415610d6e57610d6d82888c61216c565b5b610d848187606e61250e9092919063ffffffff16565b5050505050505050505050565b7f736368656d61732e7075626c69632e7461626c6573000000000000000000000060010281565b60686020528060005260406000206000915090505481565b6000610de682606e611cd490919063ffffffff16565b15610e0657610dff82606e611d6b90919063ffffffff16565b9050610e0e565b600060010290505b919050565b610e1b6112d0565b1515610e5c576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401610e53906158ec565b60405180910390fd5b600073ffffffffffffffffffffffffffffffffffffffff16603360009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff167f8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e060405160405180910390a36000603360006101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff160217905550565b6000610f27612639565b905090565b6000610f388587612081565b90506000610f468583612081565b9050610f548787848761266a565b610f5c6120de565b610f728184606e6128c59092919063ffffffff16565b5050505050505050565b6000610f86610f1d565b73ffffffffffffffffffffffffffffffffffffffff163373ffffffffffffffffffffffffffffffffffffffff16141515610ff5576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401610fec9061574c565b60405180910390fd5b61104283838080601f016020809104026020016040519081016040528093929190818152602001838380828437600081840152601f19601f820116905080830192505050505050506129f0565b905092915050565b600060019054906101000a900460ff168061106957506110686129f7565b5b8061108057506000809054906101000a900460ff16155b15156110c1576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016110b89061590c565b60405180910390fd5b60008060019054906101000a900460ff161590508015611111576001600060016101000a81548160ff02191690831515021790555060016000806101000a81548160ff0219169083151502179055505b61111a33611659565b611122612a0e565b61112a612b01565b801561114b5760008060016101000a81548160ff0219169083151502179055505b50565b600061115a8385612081565b905061116884828585612b63565b6111706120de565b6111868483606b612db79092919063ffffffff16565b5050505050565b60006060600061119b612e02565b9050600060686000838152602001908152602001600020549050606960009054906101000a900464ffffffffff1664ffffffffff16811015156111ed576111e260026130bd565b9350935050506111fc565b6111f56130df565b9350935050505b9b509b9950505050505050505050565b60006112188486612081565b905060006112268483612081565b905061123486838786612b63565b61123c6120de565b600061125282606e61310490919063ffffffff16565b90506001151581151514151561129d576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401611294906158cc565b60405180910390fd5b50505050505050565b6000603360009054906101000a900473ffffffffffffffffffffffffffffffffffffffff16905090565b6000603360009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff1661131361202d565b73ffffffffffffffffffffffffffffffffffffffff1614905090565b611337614428565b606061134d83606e61317b90919063ffffffff16565b90506113588161319b565b915050919050565b60606040805190810160405280600581526020017f312e302e30000000000000000000000000000000000000000000000000000000815250905090565b846000806113aa83611829565b915091506000821115156113f3576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016113ea906157cc565b60405180910390fd5b600182118061140d5750600115156114096112d0565b1515145b8061144a575061141b61202d565b73ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff16145b151561148b576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401611482906158ac565b60405180910390fd5b6000611497888a612081565b905060006114a58883612081565b9050600015156114bf82606e611cd490919063ffffffff16565b1515141515611503576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016114fa9061592c565b60405180910390fd5b61150b6120de565b6115218a88606b6121219092919063ffffffff16565b506000151561153a83606e611cd490919063ffffffff16565b1515141561154e5761154d82888c61216c565b5b6115648187606e6128c59092919063ffffffff16565b5050505050505050505050565b6115796112d0565b15156115ba576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016115b1906158ec565b60405180910390fd5b80606960006101000a81548164ffffffffff021916908364ffffffffff16021790555050565b6060600115156115fa83606b61324490919063ffffffff16565b151514151561163e576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401611635906159ec565b60405180910390fd5b61165282606b61326490919063ffffffff16565b9050919050565b600060019054906101000a900460ff168061167857506116776129f7565b5b8061168f57506000809054906101000a900460ff16155b15156116d0576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016116c79061590c565b60405180910390fd5b60008060019054906101000a900460ff161590508015611720576001600060016101000a81548160ff02191690831515021790555060016000806101000a81548160ff0219169083151502179055505b81603360006101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff160217905550603360009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16600073ffffffffffffffffffffffffffffffffffffffff167f8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e060405160405180910390a380156117ff5760008060016101000a81548160ff0219169083151502179055505b5050565b606660009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1681565b6000806000600102606a600085815260200190815260200160002054111515611887576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040161187e90615a4c565b60405180910390fd5b6000606a6000858152602001908152602001600020546001900490508060ff169250600881908060020a8204915050915050915091565b6118c6610f1d565b73ffffffffffffffffffffffffffffffffffffffff163373ffffffffffffffffffffffffffffffffffffffff16141515611935576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040161192c9061574c565b60405180910390fd5b61198585858080601f016020809104026020016040519081016040528093929190818152602001838380828437600081840152601f19601f820116905080830192505050505050508484846132d3565b5050505050565b60606119a282606e611cd490919063ffffffff16565b156119c2576119bb82606e61317b90919063ffffffff16565b90506119fa565b60006040519080825280601f01601f1916602001820160405280156119f65781602001600182028038833980820191505090505b5090505b919050565b611a076112d0565b1515611a48576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401611a3f906158ec565b60405180910390fd5b6000600102606a600083815260200190815260200160002081905550611a9d7f736368656d61732e7075626c69632e7461626c6573000000000000000000000060010283606e6132d99092919063ffffffff16565b50611ab281606b6132fc90919063ffffffff16565b505050565b6000611acf8383606b6133359092919063ffffffff16565b905092915050565b611adf6112d0565b1515611b20576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401611b17906158ec565b60405180910390fd5b611b2981613380565b50565b6000611b366112d0565b1515611b77576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401611b6e906158ec565b60405180910390fd5b6000611b81611cc5565b90506000611b8d611cc5565b73ffffffffffffffffffffffffffffffffffffffff166370a08231306040518263ffffffff167c0100000000000000000000000000000000000000000000000000000000028152600401611be1919061564c565b60206040518083038186803b158015611bf957600080fd5b505afa158015611c0d573d6000803e3d6000fd5b505050506040513d601f19601f82011682018060405250611c319190810190614c7a565b90508173ffffffffffffffffffffffffffffffffffffffff1662f714ce82866040518363ffffffff167c0100000000000000000000000000000000000000000000000000000000028152600401611c89929190615af2565b600060405180830381600087803b158015611ca357600080fd5b505af1158015611cb7573d6000803e3d6000fd5b505050508092505050919050565b6000611ccf612639565b905090565b6000611cec82846000016134b290919063ffffffff16565b80611d095750611d0882846003016134d290919063ffffffff16565b5b80611d265750611d25828460060161324490919063ffffffff16565b5b80611d435750611d4282846009016134f290919063ffffffff16565b5b905092915050565b6060611d63828460060161326490919063ffffffff16565b905092915050565b6000611d83828460000161351290919063ffffffff16565b905092915050565b611d936112d0565b1515611dd4576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401611dcb906158ec565b60405180910390fd5b60008260ff168117905060088273ffffffffffffffffffffffffffffffffffffffff169060020a0273ffffffffffffffffffffffffffffffffffffffff168117905080600102606a60008681526020019081526020016000208190555050505050565b6000611e4f83856000016134b290919063ffffffff16565b151515611e91576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401611e889061582c565b60405180910390fd5b611ea783856003016134d290919063ffffffff16565b151515611ee9576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401611ee09061582c565b60405180910390fd5b611eff83856009016134f290919063ffffffff16565b151515611f41576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401611f389061582c565b60405180910390fd5b611f598383866006016121219092919063ffffffff16565b90509392505050565b6000611f7a828460010161357d90919063ffffffff16565b905092915050565b611f8a614428565b81518351141515611fd0576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401611fc79061586c565b60405180910390fd5b611fd8614428565b84816000018181525050611fec84846135e9565b8160200181905250809150509392505050565b6000606061200c836136ff565b90506120248482606e61250e9092919063ffffffff16565b91505092915050565b6000612037612639565b73ffffffffffffffffffffffffffffffffffffffff163373ffffffffffffffffffffffffffffffffffffffff161415156120735733905061207e565b61207b6137cf565b90505b90565b60006060604080519080825280601f01601f1916602001820160405280156120b85781602001600182028038833980820191505090505b509050836040820152826020820152600081805190602001209050809250505092915050565b60006120e8612e02565b90506000606860008381526020019081526020016000205490506001810160686000848152602001908152602001600020819055505050565b600061212d8484613244565b15612160576121598285600001600086815260200190815260200160002061357d90919063ffffffff16565b9050612165565b600090505b9392505050565b6000151561218484606e611cd490919063ffffffff16565b15151415156121c8576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016121bf9061584c565b60405180910390fd5b600080606760009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff166392d66313426040518263ffffffff167c01000000000000000000000000000000000000000000000000000000000281526004016122429190615aae565b60206040518083038186803b15801561225a57600080fd5b505afa15801561226e573d6000803e3d6000fd5b505050506040513d601f19601f820116820180604052506122929190810190614c28565b90506000606760009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff1663a324ad24426040518263ffffffff167c010000000000000000000000000000000000000000000000000000000002815260040161230d9190615aae565b60206040518083038186803b15801561232557600080fd5b505afa158015612339573d6000803e3d6000fd5b505050506040513d601f19601f8201168201806040525061235d9190810190614cdf565b90506000606760009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff166365c72840426040518263ffffffff167c01000000000000000000000000000000000000000000000000000000000281526004016123d89190615aae565b60206040518083038186803b1580156123f057600080fd5b505afa158015612404573d6000803e3d6000fd5b505050506040513d601f19601f820116820180604052506124289190810190614cdf565b90508261ffff168417935060108260ff169060020a028417935060188160ff169060020a02841793506000847c0100000000000000000000000000000000000000000000000000000000029050602061247f61202d565b73ffffffffffffffffffffffffffffffffffffffff169060020a02851794506124b78886600102606e6128c59092919063ffffffff16565b506124c061202d565b73ffffffffffffffffffffffffffffffffffffffff1686887fc3b047ab84cb81685163ad3ef7de856809a7d1cd6d900310242d6c3dca034bc160405160405180910390a45050505050505050565b600061252683856000016134b290919063ffffffff16565b151515612568576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040161255f9061582c565b60405180910390fd5b61257e838560060161324490919063ffffffff16565b1515156125c0576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016125b79061582c565b60405180910390fd5b6125d683856009016134f290919063ffffffff16565b151515612618576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040161260f9061582c565b60405180910390fd5b6126308383866003016138479092919063ffffffff16565b90509392505050565b6000807f06b7792c761dcc05af1761f0315ce8b01ac39c16cc934eb0b2f7a8e71414f2626001029050805491505090565b600115156126848583606b6133359092919063ffffffff16565b15151415156126c8576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016126bf90615a2c565b60405180910390fd5b6000806126d486611829565b9150915060008211151561271d576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016127149061578c565b60405180910390fd5b60018211806127375750600115156127336112d0565b1515145b80612774575061274561202d565b73ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff16145b15156127b5576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016127ac9061580c565b60405180910390fd5b6002821015156128bd5760006127d585606e611d6b90919063ffffffff16565b9050600060208260019004908060020a820491505090506127f461202d565b73ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff16141561282c576128ba565b600115156128386112d0565b15151480612878575061284961202d565b73ffffffffffffffffffffffffffffffffffffffff168373ffffffffffffffffffffffffffffffffffffffff16145b15156128b9576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016128b09061588c565b60405180910390fd5b5b50505b505050505050565b60006128dd83856003016134d290919063ffffffff16565b15151561291f576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016129169061582c565b60405180910390fd5b612935838560060161324490919063ffffffff16565b151515612977576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040161296e9061582c565b60405180910390fd5b61298d83856009016134f290919063ffffffff16565b1515156129cf576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016129c69061582c565b60405180910390fd5b6129e78383866000016138929092919063ffffffff16565b90509392505050565b6000919050565b6000803090506000813b9050600081149250505090565b600060019054906101000a900460ff1680612a2d5750612a2c6129f7565b5b80612a4457506000809054906101000a900460ff16155b1515612a85576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401612a7c9061590c565b60405180910390fd5b60008060019054906101000a900460ff161590508015612ad5576001600060016101000a81548160ff02191690831515021790555060016000806101000a81548160ff0219169083151502179055505b612add6138cd565b8015612afe5760008060016101000a81548160ff0219169083151502179055505b50565b6103e8606960006101000a81548164ffffffffff021916908364ffffffffff160217905550612b607f736368656d61732e7075626c69632e7461626c657300000000000000000000006001026000606e6139d59092919063ffffffff16565b50565b60011515612b7d8583606b6133359092919063ffffffff16565b1515141515612bc1576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401612bb8906159cc565b60405180910390fd5b600080612bcd86611829565b91509150600082111515612c16576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401612c0d9061576c565b60405180910390fd5b6001821180612c30575060011515612c2c6112d0565b1515145b80612c6d5750612c3e61202d565b73ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff16145b1515612cae576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401612ca59061594c565b60405180910390fd5b600282101515612daf57612cc06112d0565b80612cfd5750612cce61202d565b73ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff16145b15612d0757612dae565b6000612d1d86606e611d6b90919063ffffffff16565b9050600060208260019004908060020a82049150509050612d3c61202d565b73ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff16141515612dab576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401612da290615a6c565b60405180910390fd5b50505b5b505050505050565b6000612dc38484613244565b15612df657612def82856000016000868152602001908152602001600020613cbd90919063ffffffff16565b9050612dfb565b600090505b9392505050565b6000806000606760009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff166392d66313426040518263ffffffff167c0100000000000000000000000000000000000000000000000000000000028152600401612e7e9190615aae565b60206040518083038186803b158015612e9657600080fd5b505afa158015612eaa573d6000803e3d6000fd5b505050506040513d601f19601f82011682018060405250612ece9190810190614c28565b90506000606760009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff1663a324ad24426040518263ffffffff167c0100000000000000000000000000000000000000000000000000000000028152600401612f499190615aae565b60206040518083038186803b158015612f6157600080fd5b505afa158015612f75573d6000803e3d6000fd5b505050506040513d601f19601f82011682018060405250612f999190810190614cdf565b90506000606760009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff166365c72840426040518263ffffffff167c01000000000000000000000000000000000000000000000000000000000281526004016130149190615aae565b60206040518083038186803b15801561302c57600080fd5b505afa158015613040573d6000803e3d6000fd5b505050506040513d601f19601f820116820180604052506130649190810190614cdf565b90508261ffff168417935060108260ff169060020a028417935060188160ff169060020a028417935083604051602001808281526020019150506040516020818303038152906040528051906020012094505050505090565b6000606082600b01602060405190810160405280600081525091509150915091565b600060606130fc6020604051908101604052806000815250613db6565b915091509091565b600061311c8284600001613dc690919063ffffffff16565b8061313957506131388284600301613e1890919063ffffffff16565b5b80613156575061315582846006016132fc90919063ffffffff16565b5b8061317357506131728284600901613e7290919063ffffffff16565b5b905092915050565b60606131938284600301613eab90919063ffffffff16565b905092915050565b6131a3614428565b6000825190506131b1614428565b6131c48285613fae90919063ffffffff16565b8160000181815250506020820391506131e68285613fbc90919063ffffffff16565b81915082602001819450829052505060008214151561323a576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016132319061572c565b60405180910390fd5b8092505050919050565b600061325c82846001016140c790919063ffffffff16565b905092915050565b60606132708383613244565b15613299576132928360000160008481526020019081526020016000206140ea565b90506132cd565b60006040519080825280602002602001820160405280156132c95781602001602082028038833980820191505090505b5090505b92915050565b50505050565b60006132f3838386600601612db79092919063ffffffff16565b90509392505050565b60006133088383613244565b1561332a576133238284600101613cbd90919063ffffffff16565b905061332f565b600090505b92915050565b60006133418484613244565b156133745761336d828560000160008681526020019081526020016000206140c790919063ffffffff16565b9050613379565b600090505b9392505050565b600073ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff16141515156133f2576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016133e9906157ac565b60405180910390fd5b8073ffffffffffffffffffffffffffffffffffffffff16603360009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff167f8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e060405160405180910390a380603360006101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff16021790555050565b60006134ca82846001016140c790919063ffffffff16565b905092915050565b60006134ea82846001016140c790919063ffffffff16565b905092915050565b600061350a82846001016140c790919063ffffffff16565b905092915050565b600061351e83836134b2565b151561355f576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040161355690615a0c565b60405180910390fd5b82600001600083815260200190815260200160002054905092915050565b600061358983836140c7565b15156135de5782600101829080600181540180825580915050906001820390600052602060002001600090919290919091505583600001600084815260200190815260200160002081905550600190506135e3565b600090505b92915050565b606081518351141515613631576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016136289061586c565b60405180910390fd5b6060835160405190808252806020026020018201604052801561366e57816020015b61365b614445565b8152602001906001900390816136535790505b50905060008090505b84518110156136f457613688614465565b858281518110151561369657fe5b9060200190602002015181600001818152505084828151811015156136b757fe5b906020019060200201518160200181815250508083838151811015156136d957fe5b90602001906020020181905250508080600101915050613677565b508091505092915050565b6060600061370c83614187565b90506060816040519080825280601f01601f1916602001820160405280156137435781602001600182028038833980820191505090505b50905061375f828286600001516141a29092919063ffffffff16565b60208203915061377e828286602001516141ac9092919063ffffffff16565b91506000821415156137c5576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016137bc9061572c565b60405180910390fd5b8092505050919050565b600060606000368080601f016020809104026020016040519081016040528093929190818152602001838380828437600081840152601f19601f820116905080830192505050505050509050600080369050905073ffffffffffffffffffffffffffffffffffffffff81830151169250829250505090565b6000818460000160008581526020019081526020016000209080519060200190613872929190614485565b50613889838560010161357d90919063ffffffff16565b90509392505050565b600081846000016000858152602001908152602001600020819055506138c4838560010161357d90919063ffffffff16565b90509392505050565b600060019054906101000a900460ff16806138ec57506138eb6129f7565b5b8061390357506000809054906101000a900460ff16155b1515613944576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040161393b9061590c565b60405180910390fd5b60008060019054906101000a900460ff161590508015613994576001600060016101000a81548160ff02191690831515021790555060016000806101000a81548160ff0219169083151502179055505b6139b173d216153c06e857cd7f72665e0af1d7d82172f494614269565b80156139d25760008060016101000a81548160ff0219169083151502179055505b50565b600060048260038111156139e557fe5b60ff16101515613a2a576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401613a219061598c565b60405180910390fd5b613a4083856000016134b290919063ffffffff16565b151515613a82576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401613a799061582c565b60405180910390fd5b613a9883856003016134d290919063ffffffff16565b151515613ada576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401613ad19061582c565b60405180910390fd5b613af0838560060161324490919063ffffffff16565b151515613b32576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401613b299061582c565b60405180910390fd5b613b4883856009016134f290919063ffffffff16565b151515613b8a576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401613b819061582c565b60405180910390fd5b816003811115613b9657fe5b60006003811115613ba357fe5b1415613bc657613bbf8385600601611f6290919063ffffffff16565b9050613cb6565b816003811115613bd257fe5b60016003811115613bdf57fe5b1415613c0257613bfb83856009016143e290919063ffffffff16565b9050613cb6565b816003811115613c0e57fe5b60026003811115613c1b57fe5b1415613c4457613c3d836000600102866000016138929092919063ffffffff16565b9050613cb6565b816003811115613c5057fe5b600380811115613c5c57fe5b1415613cb557613cae8360006040519080825280601f01601f191660200182016040528015613c9a5781602001600182028038833980820191505090505b50866003016138479092919063ffffffff16565b9050613cb6565b5b9392505050565b6000613cc983836140c7565b15613dab5760006001846000016000858152602001908152602001600020540390506000600185600101805490500390508181141515613d625760008560010182815481101515613d1657fe5b90600052602060002001549050808660010184815481101515613d3557fe5b90600052602060002001819055506001830186600001600083815260200190815260200160002081905550505b84600001600085815260200190815260200160002060009055846001018054801515613d8a57fe5b60019003818190600052602060002001600090559055600192505050613db0565b600090505b92915050565b6000606060008391509150915091565b6000613dd283836134b2565b15613e0d5782600001600083815260200190815260200160002060009055613e068284600101613cbd90919063ffffffff16565b9050613e12565b600090505b92915050565b6000613e2483836134d2565b15613e67578260000160008381526020019081526020016000206000613e4a9190614505565b613e608284600101613cbd90919063ffffffff16565b9050613e6c565b600090505b92915050565b6000613e7e83836134f2565b15613ea057613e998284600101613cbd90919063ffffffff16565b9050613ea5565b600090505b92915050565b6060613eb783836134d2565b1515613ef8576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401613eef90615a0c565b60405180910390fd5b8260000160008381526020019081526020016000208054600181600116156101000203166002900480601f016020809104026020016040519081016040528092919081815260200182805460018160011615610100020316600290048015613fa15780601f10613f7657610100808354040283529160200191613fa1565b820191906000526020600020905b815481529060010190602001808311613f8457829003601f168201915b5050505050905092915050565b600081830151905092915050565b60606000808390506000613fd9828761440290919063ffffffff16565b90506020820391506000604082811515613fef57fe5b04905060608160405190808252806020026020018201604052801561402e57816020015b61401b614445565b8152602001906001900390816140135790505b50905060008090505b828110156140b557614047614465565b61405a868b613fae90919063ffffffff16565b81600001818152505060208603955061407c868b613fae90919063ffffffff16565b81602001818152505060208603955080838381518110151561409a57fe5b90602001906020020181905250508080600101915050614037565b50808495509550505050509250929050565b600080836000016000848152602001908152602001600020541415905092915050565b60608082600101805490506040519080825280602002602001820160405280156141235781602001602082028038833980820191505090505b50905060005b836001018054905081101561417d57836001018181548110151561414957fe5b9060005260206000200154828281518110151561416257fe5b90602001906020020181815250508080600101915050614129565b5080915050919050565b60006141968260200151614410565b60208001019050919050565b8282820152505050565b6000808390506141cf81846141c088614410565b61441e9092919063ffffffff16565b60208103905060008090505b855181101561425d57614214828588848151811015156141f757fe5b90602001906020020151600001516141a29092919063ffffffff16565b60208203915061424a8285888481518110151561422d57fe5b90602001906020020151602001516141a29092919063ffffffff16565b60208203915080806001019150506141db565b50809150509392505050565b6000614273612639565b9050600073ffffffffffffffffffffffffffffffffffffffff168273ffffffffffffffffffffffffffffffffffffffff16141515156142e7576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016142de9061596c565b60405180910390fd5b8073ffffffffffffffffffffffffffffffffffffffff168273ffffffffffffffffffffffffffffffffffffffff1614151515614358576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040161434f906157ec565b60405180910390fd5b8173ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff167fb9f84b8e65164b14439ae3620df0a4d8786d896996c0282b683f9d8c08f046e860405160405180910390a360007f06b7792c761dcc05af1761f0315ce8b01ac39c16cc934eb0b2f7a8e71414f2626001029050828155505050565b60006143fa828460010161357d90919063ffffffff16565b905092915050565b600081830151905092915050565b600060408251029050919050565b8282820152505050565b604080519081016040528060008019168152602001606081525090565b604080519081016040528060008019168152602001600080191681525090565b604080519081016040528060008019168152602001600080191681525090565b828054600181600116156101000203166002900490600052602060002090601f016020900481019282601f106144c657805160ff19168380011785556144f4565b828001600101855582156144f4579182015b828111156144f35782518255916020019190600101906144d8565b5b509050614501919061454d565b5090565b50805460018160011615610100020316600290046000825580601f1061452b575061454a565b601f016020900490600052602060002090810190614549919061454d565b5b50565b61456f91905b8082111561456b576000816000905550600101614553565b5090565b90565b600061457e8235615ce8565b905092915050565b60006145928235615cfa565b905092915050565b600082601f83011215156145ad57600080fd5b81356145c06145bb82615b93565b615b66565b915081818352602084019350602081019050838560208402820111156145e557600080fd5b60005b8381101561461557816145fb8882614633565b8452602084019350602083019250506001810190506145e8565b5050505092915050565b600061462b8235615d0c565b905092915050565b600061463f8235615d18565b905092915050565b60008083601f840112151561465b57600080fd5b8235905067ffffffffffffffff81111561467457600080fd5b60208301915083600182028301111561468c57600080fd5b9250929050565b600082601f83011215156146a657600080fd5b81356146b96146b482615bbb565b615b66565b915080825260208301602083018583830111156146d557600080fd5b6146e0838284615d7d565b50505092915050565b60006146f58251615d22565b905092915050565b60006147098235615d30565b905092915050565b600061471d8251615d30565b905092915050565b60006147318235615d3a565b905092915050565b60006147458251615d3a565b905092915050565b60006020828403121561475f57600080fd5b600061476d84828501614572565b91505092915050565b60006020828403121561478857600080fd5b600061479684828501614586565b91505092915050565b60008060008060008060008060008060006101208c8e0312156147c157600080fd5b60006147cf8e828f01614572565b9b505060206147e08e828f01614572565b9a505060408c013567ffffffffffffffff8111156147fd57600080fd5b6148098e828f01614647565b9950995050606061481c8e828f016146fd565b975050608061482d8e828f016146fd565b96505060a061483e8e828f016146fd565b95505060c061484f8e828f016146fd565b94505060e08c013567ffffffffffffffff81111561486c57600080fd5b6148788e828f01614647565b935093505061010061488c8e828f016146fd565b9150509295989b509295989b9093969950565b6000602082840312156148b157600080fd5b60006148bf84828501614633565b91505092915050565b600080604083850312156148db57600080fd5b60006148e985828601614633565b92505060206148fa85828601614633565b9150509250929050565b60008060006060848603121561491957600080fd5b600061492786828701614633565b935050602061493886828701614633565b925050604061494986828701614633565b9150509250925092565b6000806000806080858703121561496957600080fd5b600061497787828801614633565b945050602061498887828801614633565b935050604061499987828801614633565b92505060606149aa87828801614633565b91505092959194509250565b600080600080600060a086880312156149ce57600080fd5b60006149dc88828901614633565b95505060206149ed88828901614633565b94505060406149fe88828901614633565b9350506060614a0f88828901614633565b9250506080614a2088828901614633565b9150509295509295909350565b600080600080600060a08688031215614a4557600080fd5b6000614a5388828901614633565b9550506020614a6488828901614633565b9450506040614a7588828901614633565b9350506060614a8688828901614633565b925050608086013567ffffffffffffffff811115614aa357600080fd5b614aaf88828901614693565b9150509295509295909350565b600080600080600060a08688031215614ad457600080fd5b6000614ae288828901614633565b9550506020614af388828901614633565b9450506040614b0488828901614725565b935050606086013567ffffffffffffffff811115614b2157600080fd5b614b2d8882890161459a565b925050608086013567ffffffffffffffff811115614b4a57600080fd5b614b568882890161459a565b9150509295509295909350565b60008060208385031215614b7657600080fd5b600083013567ffffffffffffffff811115614b9057600080fd5b614b9c85828601614647565b92509250509250929050565b600080600080600060808688031215614bc057600080fd5b600086013567ffffffffffffffff811115614bda57600080fd5b614be688828901614647565b95509550506020614bf98882890161461f565b9350506040614c0a888289016146fd565b9250506060614c1b88828901614633565b9150509295509295909350565b600060208284031215614c3a57600080fd5b6000614c48848285016146e9565b91505092915050565b600060208284031215614c6357600080fd5b6000614c71848285016146fd565b91505092915050565b600060208284031215614c8c57600080fd5b6000614c9a84828501614711565b91505092915050565b60008060408385031215614cb657600080fd5b6000614cc4858286016146fd565b9250506020614cd585828601614586565b9150509250929050565b600060208284031215614cf157600080fd5b6000614cff84828501614739565b91505092915050565b614d1181615d47565b82525050565b614d2081615c59565b82525050565b614d2f81615c47565b82525050565b6000614d4082615c01565b808452602084019350614d5283615be7565b60005b82811015614d8457614d68868351614dfa565b614d7182615c2d565b9150602086019550600181019050614d55565b50849250505092915050565b6000614d9b82615c0c565b808452602084019350614dad83615bf4565b60005b82811015614ddf57614dc38683516155a7565b614dcc82615c3a565b9150604086019550600181019050614db0565b50849250505092915050565b614df481615c6b565b82525050565b614e0381615c77565b82525050565b614e1281615c81565b82525050565b6000614e2382615c17565b808452614e37816020860160208601615d8c565b614e4081615dbf565b602085010191505092915050565b6000614e5982615c22565b808452614e6d816020860160208601615d8c565b614e7681615dbf565b602085010191505092915050565b6000601c82527f456e636f64696e67204572726f723a206f666673657420213d20302e000000006020830152604082019050919050565b6000602682527f47534e426f756e636572426173653a2063616c6c6572206973206e6f7420526560208301527f6c617948756200000000000000000000000000000000000000000000000000006040830152606082019050919050565b6000601f82527f43616e6e6f742044454c4554452066726f6d2073797374656d207461626c65006020830152604082019050919050565b6000601a82527f43616e6e6f74205550444154452073797374656d207461626c650000000000006020830152604082019050919050565b6000602682527f4f776e61626c653a206e6577206f776e657220697320746865207a65726f206160208301527f64647265737300000000000000000000000000000000000000000000000000006040830152606082019050919050565b6000601f82527f43616e6e6f7420494e5345525420696e746f2073797374656d207461626c65006020830152604082019050919050565b6000602b82527f47534e436f6e746578743a206e65772052656c6179487562206973207468652060208301527f63757272656e74206f6e650000000000000000000000000000000000000000006040830152606082019050919050565b6000602e82527f4f6e6c79206f776e65722f64656c65676174652063616e20555044415445206960208301527f6e746f2074686973207461626c650000000000000000000000000000000000006040830152606082019050919050565b6000602082527f4572726f723a206b65792065786973747320696e206f7468657220646963742e6020830152604082019050919050565b6000601582527f726f7720616c726561647920686173206f776e657200000000000000000000006020830152604082019050919050565b6000601082527f4572726f7220616c69676e6d656e742e000000000000000000000000000000006020830152604082019050919050565b6000603982527f4e6f7420726f774f776e6572206f72206f776e65722f64656c6567617465206660208301527f6f722055504441544520696e746f2074686973207461626c65000000000000006040830152606082019050919050565b6000602e82527f4f6e6c79206f776e65722f64656c65676174652063616e20494e53455254206960208301527f6e746f2074686973207461626c650000000000000000000000000000000000006040830152606082019050919050565b6000601282527f6572726f722072656d6f76696e67206b657900000000000000000000000000006020830152604082019050919050565b6000602082527f4f776e61626c653a2063616c6c6572206973206e6f7420746865206f776e65726020830152604082019050919050565b6000602e82527f436f6e747261637420696e7374616e63652068617320616c726561647920626560208301527f656e20696e697469616c697a65640000000000000000000000000000000000006040830152606082019050919050565b6000601782527f69642b6669656c6420616c7265616479206578697374730000000000000000006020830152604082019050919050565b6000602e82527f4f6e6c79206f776e65722f64656c65676174652063616e2044454c455445206660208301527f726f6d2074686973207461626c650000000000000000000000000000000000006040830152606082019050919050565b6000602c82527f47534e436f6e746578743a206e65772052656c6179487562206973207468652060208301527f7a65726f206164647265737300000000000000000000000000000000000000006040830152606082019050919050565b6000601382527f496e76616c6964207461626c65207479706521000000000000000000000000006020830152604082019050919050565b6000601482527f5461626c6520616c7265616479206578697374730000000000000000000000006020830152604082019050919050565b6000601082527f696420646f65736e2774206578697374000000000000000000000000000000006020830152604082019050919050565b6000601182527f7461626c65206e6f7420637265617465640000000000000000000000000000006020830152604082019050919050565b6000601382527f4b657920646f6573206e6f7420657869737421000000000000000000000000006020830152604082019050919050565b6000601c82527f696420646f65736e27742065786973742c2075736520494e53455254000000006020830152604082019050919050565b6000601482527f7461626c6520646f6573206e6f742065786973740000000000000000000000006020830152604082019050919050565b6000601782527f53656e646572206e6f74206f776e6572206f6620726f770000000000000000006020830152604082019050919050565b6040820160008201516155bd6000850182614dfa565b5060208201516155d06020850182614dfa565b50505050565b60006040830160008301516155ee6000860182614dfa565b50602083015184820360208601526156068282614d90565b9150508091505092915050565b61561c81615ccd565b82525050565b61562b81615cd7565b82525050565b60006020820190506156466000830184614d26565b92915050565b60006020820190506156616000830184614d08565b92915050565b600060408201905061567c6000830185614d26565b6156896020830184614e09565b9392505050565b600060208201905081810360008301526156aa8184614d35565b905092915050565b60006020820190506156c76000830184614deb565b92915050565b60006020820190506156e26000830184614dfa565b92915050565b600060208201905081810360008301526157028184614e18565b905092915050565b600060208201905081810360008301526157248184614e4e565b905092915050565b6000602082019050818103600083015261574581614e84565b9050919050565b6000602082019050818103600083015261576581614ebb565b9050919050565b6000602082019050818103600083015261578581614f18565b9050919050565b600060208201905081810360008301526157a581614f4f565b9050919050565b600060208201905081810360008301526157c581614f86565b9050919050565b600060208201905081810360008301526157e581614fe3565b9050919050565b600060208201905081810360008301526158058161501a565b9050919050565b6000602082019050818103600083015261582581615077565b9050919050565b60006020820190508181036000830152615845816150d4565b9050919050565b600060208201905081810360008301526158658161510b565b9050919050565b6000602082019050818103600083015261588581615142565b9050919050565b600060208201905081810360008301526158a581615179565b9050919050565b600060208201905081810360008301526158c5816151d6565b9050919050565b600060208201905081810360008301526158e581615233565b9050919050565b600060208201905081810360008301526159058161526a565b9050919050565b60006020820190508181036000830152615925816152a1565b9050919050565b60006020820190508181036000830152615945816152fe565b9050919050565b6000602082019050818103600083015261596581615335565b9050919050565b6000602082019050818103600083015261598581615392565b9050919050565b600060208201905081810360008301526159a5816153ef565b9050919050565b600060208201905081810360008301526159c581615426565b9050919050565b600060208201905081810360008301526159e58161545d565b9050919050565b60006020820190508181036000830152615a0581615494565b9050919050565b60006020820190508181036000830152615a25816154cb565b9050919050565b60006020820190508181036000830152615a4581615502565b9050919050565b60006020820190508181036000830152615a6581615539565b9050919050565b60006020820190508181036000830152615a8581615570565b9050919050565b60006020820190508181036000830152615aa681846155d6565b905092915050565b6000602082019050615ac36000830184615613565b92915050565b6000604082019050615ade6000830185615613565b615aeb6020830184614d26565b9392505050565b6000604082019050615b076000830185615613565b615b146020830184614d17565b9392505050565b6000604082019050615b306000830185615613565b8181036020830152615b428184614e18565b90509392505050565b6000602082019050615b606000830184615622565b92915050565b6000604051905081810181811067ffffffffffffffff82111715615b8957600080fd5b8060405250919050565b600067ffffffffffffffff821115615baa57600080fd5b602082029050602081019050919050565b600067ffffffffffffffff821115615bd257600080fd5b601f19601f8301169050602081019050919050565b6000602082019050919050565b6000602082019050919050565b600081519050919050565b600081519050919050565b600081519050919050565b600081519050919050565b6000602082019050919050565b6000602082019050919050565b6000615c5282615cad565b9050919050565b6000615c6482615cad565b9050919050565b60008115159050919050565b6000819050919050565b60007fffffffff0000000000000000000000000000000000000000000000000000000082169050919050565b600073ffffffffffffffffffffffffffffffffffffffff82169050919050565b6000819050919050565b600064ffffffffff82169050919050565b6000615cf382615cad565b9050919050565b6000615d0582615cad565b9050919050565b60008115159050919050565b6000819050919050565b600061ffff82169050919050565b6000819050919050565b600060ff82169050919050565b6000615d5282615d59565b9050919050565b6000615d6482615d6b565b9050919050565b6000615d7682615cad565b9050919050565b82818337600083830152505050565b60005b83811015615daa578082015181840152602081019050615d8f565b83811115615db9576000848401525b50505050565b6000601f19601f830116905091905056fea265627a7a72305820ff8cf2bee6c65ce1b61259b8bf1a6b74384f8ff08cb8ad1cd247e3d7877932b96c6578706572696d656e74616cf50037";
var deployedBytecode = "0x6080604052600436106101b6576000357c0100000000000000000000000000000000000000000000000000000000900463ffffffff168062f714ce146101b857806301ee810a146101e15780631fd6dda51461020c57806328343c3414610249578063287e724614610274578063365628a2146102b25780633c2e8599146102db5780633ffe300e146103065780634102fbf61461032f57806359cb73a41461035a5780636729003c14610397578063715018a6146103d457806374e861d6146103eb5780637e03a8241461041657806380274db71461043f5780638129fc1c1461047c5780638175d7eb1461049357806383947ea0146104bc5780638d3178cc146104fa5780638da5cb5b146105235780638f32d59b1461054e578063a2ea7c6e14610579578063ad61ccd5146105b6578063b467949b146105e1578063bc41c3dd1461060a578063c2309bf914610633578063c4d66de814610670578063d2c5ce3114610699578063d887f105146106c4578063e06e0e2214610702578063e3c504e41461072b578063ed90cb3714610768578063f201fe2a14610791578063f2fde38b146107ce578063fa09e630146107f7575b005b3480156101c457600080fd5b506101df60048036036101da9190810190614ca3565b610834565b005b3480156101ed57600080fd5b506101f6610916565b6040516102039190615b4b565b60405180910390f35b34801561021857600080fd5b50610233600480360361022e919081019061489f565b61092d565b60405161024091906156b2565b60405180910390f35b34801561025557600080fd5b5061025e61094a565b60405161026b9190615690565b60405180910390f35b34801561028057600080fd5b5061029b6004803603610296919081019061489f565b610988565b6040516102a9929190615667565b60405180910390f35b3480156102be57600080fd5b506102d960048036036102d49190810190614abc565b6109de565b005b3480156102e757600080fd5b506102f0610b0a565b6040516102fd9190615aae565b60405180910390f35b34801561031257600080fd5b5061032d60048036036103289190810190614a2d565b610bbd565b005b34801561033b57600080fd5b50610344610d91565b60405161035191906156cd565b60405180910390f35b34801561036657600080fd5b50610381600480360361037c919081019061489f565b610db8565b60405161038e9190615aae565b60405180910390f35b3480156103a357600080fd5b506103be60048036036103b9919081019061489f565b610dd0565b6040516103cb91906156cd565b60405180910390f35b3480156103e057600080fd5b506103e9610e13565b005b3480156103f757600080fd5b50610400610f1d565b60405161040d9190615631565b60405180910390f35b34801561042257600080fd5b5061043d600480360361043891908101906149b6565b610f2c565b005b34801561044b57600080fd5b5061046660048036036104619190810190614b63565b610f7c565b60405161047391906156cd565b60405180910390f35b34801561048857600080fd5b5061049161104a565b005b34801561049f57600080fd5b506104ba60048036036104b59190810190614904565b61114e565b005b3480156104c857600080fd5b506104e360048036036104de919081019061479f565b61118d565b6040516104f1929190615b1b565b60405180910390f35b34801561050657600080fd5b50610521600480360361051c9190810190614953565b61120c565b005b34801561052f57600080fd5b506105386112a6565b6040516105459190615631565b60405180910390f35b34801561055a57600080fd5b506105636112d0565b60405161057091906156b2565b60405180910390f35b34801561058557600080fd5b506105a0600480360361059b919081019061489f565b61132f565b6040516105ad9190615a8c565b60405180910390f35b3480156105c257600080fd5b506105cb611360565b6040516105d8919061570a565b60405180910390f35b3480156105ed57600080fd5b50610608600480360361060391908101906149b6565b61139d565b005b34801561061657600080fd5b50610631600480360361062c9190810190614c51565b611571565b005b34801561063f57600080fd5b5061065a6004803603610655919081019061489f565b6115e0565b6040516106679190615690565b60405180910390f35b34801561067c57600080fd5b506106976004803603610692919081019061474d565b611659565b005b3480156106a557600080fd5b506106ae611803565b6040516106bb9190615631565b60405180910390f35b3480156106d057600080fd5b506106eb60048036036106e6919081019061489f565b611829565b6040516106f9929190615ac9565b60405180910390f35b34801561070e57600080fd5b5061072960048036036107249190810190614ba8565b6118be565b005b34801561073757600080fd5b50610752600480360361074d919081019061489f565b61198c565b60405161075f91906156e8565b60405180910390f35b34801561077457600080fd5b5061078f600480360361078a91908101906148c8565b6119ff565b005b34801561079d57600080fd5b506107b860048036036107b391908101906148c8565b611ab7565b6040516107c591906156b2565b60405180910390f35b3480156107da57600080fd5b506107f560048036036107f0919081019061474d565b611ad7565b005b34801561080357600080fd5b5061081e60048036036108199190810190614776565b611b2c565b60405161082b9190615aae565b60405180910390f35b61083c6112d0565b151561087d576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401610874906158ec565b60405180910390fd5b6000610887611cc5565b90508073ffffffffffffffffffffffffffffffffffffffff1662f714ce84846040518363ffffffff167c01000000000000000000000000000000000000000000000000000000000281526004016108df929190615af2565b600060405180830381600087803b1580156108f957600080fd5b505af115801561090d573d6000803e3d6000fd5b50505050505050565b606960009054906101000a900464ffffffffff1681565b600061094382606e611cd490919063ffffffff16565b9050919050565b60606109837f736368656d61732e7075626c69632e7461626c65730000000000000000000000600102606e611d4b90919063ffffffff16565b905090565b60008060006109a184606e611d6b90919063ffffffff16565b600190049050807c0100000000000000000000000000000000000000000000000000000000029150602081908060020a8204915050925050915091565b6109e66112d0565b1515610a27576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401610a1e906158ec565b60405180910390fd5b6000600102606a600086815260200190815260200160002054141515610a82576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401610a79906159ac565b60405180910390fd5b6000809050610a92858583611d8b565b610acb7f736368656d61732e7075626c69632e7461626c6573000000000000000000000060010287606e611e379092919063ffffffff16565b50610ae085606b611f6290919063ffffffff16565b50610ae9614428565b610af4878585611f82565b9050610b008682611fff565b5050505050505050565b6000610b14611cc5565b73ffffffffffffffffffffffffffffffffffffffff166370a08231306040518263ffffffff167c0100000000000000000000000000000000000000000000000000000000028152600401610b68919061564c565b60206040518083038186803b158015610b8057600080fd5b505afa158015610b94573d6000803e3d6000fd5b505050506040513d601f19601f82011682018060405250610bb89190810190614c7a565b905090565b84600080610bca83611829565b91509150600082111515610c13576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401610c0a906157cc565b60405180910390fd5b6001821180610c2d575060011515610c296112d0565b1515145b80610c6a5750610c3b61202d565b73ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff16145b1515610cab576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401610ca2906158ac565b60405180910390fd5b6000610cb7888a612081565b90506000610cc58883612081565b905060001515610cdf82606e611cd490919063ffffffff16565b1515141515610d23576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401610d1a9061592c565b60405180910390fd5b610d2b6120de565b610d418a88606b6121219092919063ffffffff16565b5060001515610d5a83606e611cd490919063ffffffff16565b15151415610d6e57610d6d82888c61216c565b5b610d848187606e61250e9092919063ffffffff16565b5050505050505050505050565b7f736368656d61732e7075626c69632e7461626c6573000000000000000000000060010281565b60686020528060005260406000206000915090505481565b6000610de682606e611cd490919063ffffffff16565b15610e0657610dff82606e611d6b90919063ffffffff16565b9050610e0e565b600060010290505b919050565b610e1b6112d0565b1515610e5c576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401610e53906158ec565b60405180910390fd5b600073ffffffffffffffffffffffffffffffffffffffff16603360009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff167f8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e060405160405180910390a36000603360006101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff160217905550565b6000610f27612639565b905090565b6000610f388587612081565b90506000610f468583612081565b9050610f548787848761266a565b610f5c6120de565b610f728184606e6128c59092919063ffffffff16565b5050505050505050565b6000610f86610f1d565b73ffffffffffffffffffffffffffffffffffffffff163373ffffffffffffffffffffffffffffffffffffffff16141515610ff5576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401610fec9061574c565b60405180910390fd5b61104283838080601f016020809104026020016040519081016040528093929190818152602001838380828437600081840152601f19601f820116905080830192505050505050506129f0565b905092915050565b600060019054906101000a900460ff168061106957506110686129f7565b5b8061108057506000809054906101000a900460ff16155b15156110c1576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016110b89061590c565b60405180910390fd5b60008060019054906101000a900460ff161590508015611111576001600060016101000a81548160ff02191690831515021790555060016000806101000a81548160ff0219169083151502179055505b61111a33611659565b611122612a0e565b61112a612b01565b801561114b5760008060016101000a81548160ff0219169083151502179055505b50565b600061115a8385612081565b905061116884828585612b63565b6111706120de565b6111868483606b612db79092919063ffffffff16565b5050505050565b60006060600061119b612e02565b9050600060686000838152602001908152602001600020549050606960009054906101000a900464ffffffffff1664ffffffffff16811015156111ed576111e260026130bd565b9350935050506111fc565b6111f56130df565b9350935050505b9b509b9950505050505050505050565b60006112188486612081565b905060006112268483612081565b905061123486838786612b63565b61123c6120de565b600061125282606e61310490919063ffffffff16565b90506001151581151514151561129d576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401611294906158cc565b60405180910390fd5b50505050505050565b6000603360009054906101000a900473ffffffffffffffffffffffffffffffffffffffff16905090565b6000603360009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff1661131361202d565b73ffffffffffffffffffffffffffffffffffffffff1614905090565b611337614428565b606061134d83606e61317b90919063ffffffff16565b90506113588161319b565b915050919050565b60606040805190810160405280600581526020017f312e302e30000000000000000000000000000000000000000000000000000000815250905090565b846000806113aa83611829565b915091506000821115156113f3576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016113ea906157cc565b60405180910390fd5b600182118061140d5750600115156114096112d0565b1515145b8061144a575061141b61202d565b73ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff16145b151561148b576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401611482906158ac565b60405180910390fd5b6000611497888a612081565b905060006114a58883612081565b9050600015156114bf82606e611cd490919063ffffffff16565b1515141515611503576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016114fa9061592c565b60405180910390fd5b61150b6120de565b6115218a88606b6121219092919063ffffffff16565b506000151561153a83606e611cd490919063ffffffff16565b1515141561154e5761154d82888c61216c565b5b6115648187606e6128c59092919063ffffffff16565b5050505050505050505050565b6115796112d0565b15156115ba576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016115b1906158ec565b60405180910390fd5b80606960006101000a81548164ffffffffff021916908364ffffffffff16021790555050565b6060600115156115fa83606b61324490919063ffffffff16565b151514151561163e576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401611635906159ec565b60405180910390fd5b61165282606b61326490919063ffffffff16565b9050919050565b600060019054906101000a900460ff168061167857506116776129f7565b5b8061168f57506000809054906101000a900460ff16155b15156116d0576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016116c79061590c565b60405180910390fd5b60008060019054906101000a900460ff161590508015611720576001600060016101000a81548160ff02191690831515021790555060016000806101000a81548160ff0219169083151502179055505b81603360006101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff160217905550603360009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16600073ffffffffffffffffffffffffffffffffffffffff167f8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e060405160405180910390a380156117ff5760008060016101000a81548160ff0219169083151502179055505b5050565b606660009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1681565b6000806000600102606a600085815260200190815260200160002054111515611887576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040161187e90615a4c565b60405180910390fd5b6000606a6000858152602001908152602001600020546001900490508060ff169250600881908060020a8204915050915050915091565b6118c6610f1d565b73ffffffffffffffffffffffffffffffffffffffff163373ffffffffffffffffffffffffffffffffffffffff16141515611935576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040161192c9061574c565b60405180910390fd5b61198585858080601f016020809104026020016040519081016040528093929190818152602001838380828437600081840152601f19601f820116905080830192505050505050508484846132d3565b5050505050565b60606119a282606e611cd490919063ffffffff16565b156119c2576119bb82606e61317b90919063ffffffff16565b90506119fa565b60006040519080825280601f01601f1916602001820160405280156119f65781602001600182028038833980820191505090505b5090505b919050565b611a076112d0565b1515611a48576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401611a3f906158ec565b60405180910390fd5b6000600102606a600083815260200190815260200160002081905550611a9d7f736368656d61732e7075626c69632e7461626c6573000000000000000000000060010283606e6132d99092919063ffffffff16565b50611ab281606b6132fc90919063ffffffff16565b505050565b6000611acf8383606b6133359092919063ffffffff16565b905092915050565b611adf6112d0565b1515611b20576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401611b17906158ec565b60405180910390fd5b611b2981613380565b50565b6000611b366112d0565b1515611b77576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401611b6e906158ec565b60405180910390fd5b6000611b81611cc5565b90506000611b8d611cc5565b73ffffffffffffffffffffffffffffffffffffffff166370a08231306040518263ffffffff167c0100000000000000000000000000000000000000000000000000000000028152600401611be1919061564c565b60206040518083038186803b158015611bf957600080fd5b505afa158015611c0d573d6000803e3d6000fd5b505050506040513d601f19601f82011682018060405250611c319190810190614c7a565b90508173ffffffffffffffffffffffffffffffffffffffff1662f714ce82866040518363ffffffff167c0100000000000000000000000000000000000000000000000000000000028152600401611c89929190615af2565b600060405180830381600087803b158015611ca357600080fd5b505af1158015611cb7573d6000803e3d6000fd5b505050508092505050919050565b6000611ccf612639565b905090565b6000611cec82846000016134b290919063ffffffff16565b80611d095750611d0882846003016134d290919063ffffffff16565b5b80611d265750611d25828460060161324490919063ffffffff16565b5b80611d435750611d4282846009016134f290919063ffffffff16565b5b905092915050565b6060611d63828460060161326490919063ffffffff16565b905092915050565b6000611d83828460000161351290919063ffffffff16565b905092915050565b611d936112d0565b1515611dd4576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401611dcb906158ec565b60405180910390fd5b60008260ff168117905060088273ffffffffffffffffffffffffffffffffffffffff169060020a0273ffffffffffffffffffffffffffffffffffffffff168117905080600102606a60008681526020019081526020016000208190555050505050565b6000611e4f83856000016134b290919063ffffffff16565b151515611e91576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401611e889061582c565b60405180910390fd5b611ea783856003016134d290919063ffffffff16565b151515611ee9576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401611ee09061582c565b60405180910390fd5b611eff83856009016134f290919063ffffffff16565b151515611f41576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401611f389061582c565b60405180910390fd5b611f598383866006016121219092919063ffffffff16565b90509392505050565b6000611f7a828460010161357d90919063ffffffff16565b905092915050565b611f8a614428565b81518351141515611fd0576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401611fc79061586c565b60405180910390fd5b611fd8614428565b84816000018181525050611fec84846135e9565b8160200181905250809150509392505050565b6000606061200c836136ff565b90506120248482606e61250e9092919063ffffffff16565b91505092915050565b6000612037612639565b73ffffffffffffffffffffffffffffffffffffffff163373ffffffffffffffffffffffffffffffffffffffff161415156120735733905061207e565b61207b6137cf565b90505b90565b60006060604080519080825280601f01601f1916602001820160405280156120b85781602001600182028038833980820191505090505b509050836040820152826020820152600081805190602001209050809250505092915050565b60006120e8612e02565b90506000606860008381526020019081526020016000205490506001810160686000848152602001908152602001600020819055505050565b600061212d8484613244565b15612160576121598285600001600086815260200190815260200160002061357d90919063ffffffff16565b9050612165565b600090505b9392505050565b6000151561218484606e611cd490919063ffffffff16565b15151415156121c8576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016121bf9061584c565b60405180910390fd5b600080606760009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff166392d66313426040518263ffffffff167c01000000000000000000000000000000000000000000000000000000000281526004016122429190615aae565b60206040518083038186803b15801561225a57600080fd5b505afa15801561226e573d6000803e3d6000fd5b505050506040513d601f19601f820116820180604052506122929190810190614c28565b90506000606760009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff1663a324ad24426040518263ffffffff167c010000000000000000000000000000000000000000000000000000000002815260040161230d9190615aae565b60206040518083038186803b15801561232557600080fd5b505afa158015612339573d6000803e3d6000fd5b505050506040513d601f19601f8201168201806040525061235d9190810190614cdf565b90506000606760009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff166365c72840426040518263ffffffff167c01000000000000000000000000000000000000000000000000000000000281526004016123d89190615aae565b60206040518083038186803b1580156123f057600080fd5b505afa158015612404573d6000803e3d6000fd5b505050506040513d601f19601f820116820180604052506124289190810190614cdf565b90508261ffff168417935060108260ff169060020a028417935060188160ff169060020a02841793506000847c0100000000000000000000000000000000000000000000000000000000029050602061247f61202d565b73ffffffffffffffffffffffffffffffffffffffff169060020a02851794506124b78886600102606e6128c59092919063ffffffff16565b506124c061202d565b73ffffffffffffffffffffffffffffffffffffffff1686887fc3b047ab84cb81685163ad3ef7de856809a7d1cd6d900310242d6c3dca034bc160405160405180910390a45050505050505050565b600061252683856000016134b290919063ffffffff16565b151515612568576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040161255f9061582c565b60405180910390fd5b61257e838560060161324490919063ffffffff16565b1515156125c0576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016125b79061582c565b60405180910390fd5b6125d683856009016134f290919063ffffffff16565b151515612618576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040161260f9061582c565b60405180910390fd5b6126308383866003016138479092919063ffffffff16565b90509392505050565b6000807f06b7792c761dcc05af1761f0315ce8b01ac39c16cc934eb0b2f7a8e71414f2626001029050805491505090565b600115156126848583606b6133359092919063ffffffff16565b15151415156126c8576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016126bf90615a2c565b60405180910390fd5b6000806126d486611829565b9150915060008211151561271d576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016127149061578c565b60405180910390fd5b60018211806127375750600115156127336112d0565b1515145b80612774575061274561202d565b73ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff16145b15156127b5576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016127ac9061580c565b60405180910390fd5b6002821015156128bd5760006127d585606e611d6b90919063ffffffff16565b9050600060208260019004908060020a820491505090506127f461202d565b73ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff16141561282c576128ba565b600115156128386112d0565b15151480612878575061284961202d565b73ffffffffffffffffffffffffffffffffffffffff168373ffffffffffffffffffffffffffffffffffffffff16145b15156128b9576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016128b09061588c565b60405180910390fd5b5b50505b505050505050565b60006128dd83856003016134d290919063ffffffff16565b15151561291f576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016129169061582c565b60405180910390fd5b612935838560060161324490919063ffffffff16565b151515612977576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040161296e9061582c565b60405180910390fd5b61298d83856009016134f290919063ffffffff16565b1515156129cf576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016129c69061582c565b60405180910390fd5b6129e78383866000016138929092919063ffffffff16565b90509392505050565b6000919050565b6000803090506000813b9050600081149250505090565b600060019054906101000a900460ff1680612a2d5750612a2c6129f7565b5b80612a4457506000809054906101000a900460ff16155b1515612a85576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401612a7c9061590c565b60405180910390fd5b60008060019054906101000a900460ff161590508015612ad5576001600060016101000a81548160ff02191690831515021790555060016000806101000a81548160ff0219169083151502179055505b612add6138cd565b8015612afe5760008060016101000a81548160ff0219169083151502179055505b50565b6103e8606960006101000a81548164ffffffffff021916908364ffffffffff160217905550612b607f736368656d61732e7075626c69632e7461626c657300000000000000000000006001026000606e6139d59092919063ffffffff16565b50565b60011515612b7d8583606b6133359092919063ffffffff16565b1515141515612bc1576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401612bb8906159cc565b60405180910390fd5b600080612bcd86611829565b91509150600082111515612c16576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401612c0d9061576c565b60405180910390fd5b6001821180612c30575060011515612c2c6112d0565b1515145b80612c6d5750612c3e61202d565b73ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff16145b1515612cae576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401612ca59061594c565b60405180910390fd5b600282101515612daf57612cc06112d0565b80612cfd5750612cce61202d565b73ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff16145b15612d0757612dae565b6000612d1d86606e611d6b90919063ffffffff16565b9050600060208260019004908060020a82049150509050612d3c61202d565b73ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff16141515612dab576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401612da290615a6c565b60405180910390fd5b50505b5b505050505050565b6000612dc38484613244565b15612df657612def82856000016000868152602001908152602001600020613cbd90919063ffffffff16565b9050612dfb565b600090505b9392505050565b6000806000606760009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff166392d66313426040518263ffffffff167c0100000000000000000000000000000000000000000000000000000000028152600401612e7e9190615aae565b60206040518083038186803b158015612e9657600080fd5b505afa158015612eaa573d6000803e3d6000fd5b505050506040513d601f19601f82011682018060405250612ece9190810190614c28565b90506000606760009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff1663a324ad24426040518263ffffffff167c0100000000000000000000000000000000000000000000000000000000028152600401612f499190615aae565b60206040518083038186803b158015612f6157600080fd5b505afa158015612f75573d6000803e3d6000fd5b505050506040513d601f19601f82011682018060405250612f999190810190614cdf565b90506000606760009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff166365c72840426040518263ffffffff167c01000000000000000000000000000000000000000000000000000000000281526004016130149190615aae565b60206040518083038186803b15801561302c57600080fd5b505afa158015613040573d6000803e3d6000fd5b505050506040513d601f19601f820116820180604052506130649190810190614cdf565b90508261ffff168417935060108260ff169060020a028417935060188160ff169060020a028417935083604051602001808281526020019150506040516020818303038152906040528051906020012094505050505090565b6000606082600b01602060405190810160405280600081525091509150915091565b600060606130fc6020604051908101604052806000815250613db6565b915091509091565b600061311c8284600001613dc690919063ffffffff16565b8061313957506131388284600301613e1890919063ffffffff16565b5b80613156575061315582846006016132fc90919063ffffffff16565b5b8061317357506131728284600901613e7290919063ffffffff16565b5b905092915050565b60606131938284600301613eab90919063ffffffff16565b905092915050565b6131a3614428565b6000825190506131b1614428565b6131c48285613fae90919063ffffffff16565b8160000181815250506020820391506131e68285613fbc90919063ffffffff16565b81915082602001819450829052505060008214151561323a576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016132319061572c565b60405180910390fd5b8092505050919050565b600061325c82846001016140c790919063ffffffff16565b905092915050565b60606132708383613244565b15613299576132928360000160008481526020019081526020016000206140ea565b90506132cd565b60006040519080825280602002602001820160405280156132c95781602001602082028038833980820191505090505b5090505b92915050565b50505050565b60006132f3838386600601612db79092919063ffffffff16565b90509392505050565b60006133088383613244565b1561332a576133238284600101613cbd90919063ffffffff16565b905061332f565b600090505b92915050565b60006133418484613244565b156133745761336d828560000160008681526020019081526020016000206140c790919063ffffffff16565b9050613379565b600090505b9392505050565b600073ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff16141515156133f2576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016133e9906157ac565b60405180910390fd5b8073ffffffffffffffffffffffffffffffffffffffff16603360009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff167f8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e060405160405180910390a380603360006101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff16021790555050565b60006134ca82846001016140c790919063ffffffff16565b905092915050565b60006134ea82846001016140c790919063ffffffff16565b905092915050565b600061350a82846001016140c790919063ffffffff16565b905092915050565b600061351e83836134b2565b151561355f576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040161355690615a0c565b60405180910390fd5b82600001600083815260200190815260200160002054905092915050565b600061358983836140c7565b15156135de5782600101829080600181540180825580915050906001820390600052602060002001600090919290919091505583600001600084815260200190815260200160002081905550600190506135e3565b600090505b92915050565b606081518351141515613631576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016136289061586c565b60405180910390fd5b6060835160405190808252806020026020018201604052801561366e57816020015b61365b614445565b8152602001906001900390816136535790505b50905060008090505b84518110156136f457613688614465565b858281518110151561369657fe5b9060200190602002015181600001818152505084828151811015156136b757fe5b906020019060200201518160200181815250508083838151811015156136d957fe5b90602001906020020181905250508080600101915050613677565b508091505092915050565b6060600061370c83614187565b90506060816040519080825280601f01601f1916602001820160405280156137435781602001600182028038833980820191505090505b50905061375f828286600001516141a29092919063ffffffff16565b60208203915061377e828286602001516141ac9092919063ffffffff16565b91506000821415156137c5576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016137bc9061572c565b60405180910390fd5b8092505050919050565b600060606000368080601f016020809104026020016040519081016040528093929190818152602001838380828437600081840152601f19601f820116905080830192505050505050509050600080369050905073ffffffffffffffffffffffffffffffffffffffff81830151169250829250505090565b6000818460000160008581526020019081526020016000209080519060200190613872929190614485565b50613889838560010161357d90919063ffffffff16565b90509392505050565b600081846000016000858152602001908152602001600020819055506138c4838560010161357d90919063ffffffff16565b90509392505050565b600060019054906101000a900460ff16806138ec57506138eb6129f7565b5b8061390357506000809054906101000a900460ff16155b1515613944576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040161393b9061590c565b60405180910390fd5b60008060019054906101000a900460ff161590508015613994576001600060016101000a81548160ff02191690831515021790555060016000806101000a81548160ff0219169083151502179055505b6139b173d216153c06e857cd7f72665e0af1d7d82172f494614269565b80156139d25760008060016101000a81548160ff0219169083151502179055505b50565b600060048260038111156139e557fe5b60ff16101515613a2a576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401613a219061598c565b60405180910390fd5b613a4083856000016134b290919063ffffffff16565b151515613a82576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401613a799061582c565b60405180910390fd5b613a9883856003016134d290919063ffffffff16565b151515613ada576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401613ad19061582c565b60405180910390fd5b613af0838560060161324490919063ffffffff16565b151515613b32576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401613b299061582c565b60405180910390fd5b613b4883856009016134f290919063ffffffff16565b151515613b8a576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401613b819061582c565b60405180910390fd5b816003811115613b9657fe5b60006003811115613ba357fe5b1415613bc657613bbf8385600601611f6290919063ffffffff16565b9050613cb6565b816003811115613bd257fe5b60016003811115613bdf57fe5b1415613c0257613bfb83856009016143e290919063ffffffff16565b9050613cb6565b816003811115613c0e57fe5b60026003811115613c1b57fe5b1415613c4457613c3d836000600102866000016138929092919063ffffffff16565b9050613cb6565b816003811115613c5057fe5b600380811115613c5c57fe5b1415613cb557613cae8360006040519080825280601f01601f191660200182016040528015613c9a5781602001600182028038833980820191505090505b50866003016138479092919063ffffffff16565b9050613cb6565b5b9392505050565b6000613cc983836140c7565b15613dab5760006001846000016000858152602001908152602001600020540390506000600185600101805490500390508181141515613d625760008560010182815481101515613d1657fe5b90600052602060002001549050808660010184815481101515613d3557fe5b90600052602060002001819055506001830186600001600083815260200190815260200160002081905550505b84600001600085815260200190815260200160002060009055846001018054801515613d8a57fe5b60019003818190600052602060002001600090559055600192505050613db0565b600090505b92915050565b6000606060008391509150915091565b6000613dd283836134b2565b15613e0d5782600001600083815260200190815260200160002060009055613e068284600101613cbd90919063ffffffff16565b9050613e12565b600090505b92915050565b6000613e2483836134d2565b15613e67578260000160008381526020019081526020016000206000613e4a9190614505565b613e608284600101613cbd90919063ffffffff16565b9050613e6c565b600090505b92915050565b6000613e7e83836134f2565b15613ea057613e998284600101613cbd90919063ffffffff16565b9050613ea5565b600090505b92915050565b6060613eb783836134d2565b1515613ef8576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401613eef90615a0c565b60405180910390fd5b8260000160008381526020019081526020016000208054600181600116156101000203166002900480601f016020809104026020016040519081016040528092919081815260200182805460018160011615610100020316600290048015613fa15780601f10613f7657610100808354040283529160200191613fa1565b820191906000526020600020905b815481529060010190602001808311613f8457829003601f168201915b5050505050905092915050565b600081830151905092915050565b60606000808390506000613fd9828761440290919063ffffffff16565b90506020820391506000604082811515613fef57fe5b04905060608160405190808252806020026020018201604052801561402e57816020015b61401b614445565b8152602001906001900390816140135790505b50905060008090505b828110156140b557614047614465565b61405a868b613fae90919063ffffffff16565b81600001818152505060208603955061407c868b613fae90919063ffffffff16565b81602001818152505060208603955080838381518110151561409a57fe5b90602001906020020181905250508080600101915050614037565b50808495509550505050509250929050565b600080836000016000848152602001908152602001600020541415905092915050565b60608082600101805490506040519080825280602002602001820160405280156141235781602001602082028038833980820191505090505b50905060005b836001018054905081101561417d57836001018181548110151561414957fe5b9060005260206000200154828281518110151561416257fe5b90602001906020020181815250508080600101915050614129565b5080915050919050565b60006141968260200151614410565b60208001019050919050565b8282820152505050565b6000808390506141cf81846141c088614410565b61441e9092919063ffffffff16565b60208103905060008090505b855181101561425d57614214828588848151811015156141f757fe5b90602001906020020151600001516141a29092919063ffffffff16565b60208203915061424a8285888481518110151561422d57fe5b90602001906020020151602001516141a29092919063ffffffff16565b60208203915080806001019150506141db565b50809150509392505050565b6000614273612639565b9050600073ffffffffffffffffffffffffffffffffffffffff168273ffffffffffffffffffffffffffffffffffffffff16141515156142e7576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016142de9061596c565b60405180910390fd5b8073ffffffffffffffffffffffffffffffffffffffff168273ffffffffffffffffffffffffffffffffffffffff1614151515614358576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040161434f906157ec565b60405180910390fd5b8173ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff167fb9f84b8e65164b14439ae3620df0a4d8786d896996c0282b683f9d8c08f046e860405160405180910390a360007f06b7792c761dcc05af1761f0315ce8b01ac39c16cc934eb0b2f7a8e71414f2626001029050828155505050565b60006143fa828460010161357d90919063ffffffff16565b905092915050565b600081830151905092915050565b600060408251029050919050565b8282820152505050565b604080519081016040528060008019168152602001606081525090565b604080519081016040528060008019168152602001600080191681525090565b604080519081016040528060008019168152602001600080191681525090565b828054600181600116156101000203166002900490600052602060002090601f016020900481019282601f106144c657805160ff19168380011785556144f4565b828001600101855582156144f4579182015b828111156144f35782518255916020019190600101906144d8565b5b509050614501919061454d565b5090565b50805460018160011615610100020316600290046000825580601f1061452b575061454a565b601f016020900490600052602060002090810190614549919061454d565b5b50565b61456f91905b8082111561456b576000816000905550600101614553565b5090565b90565b600061457e8235615ce8565b905092915050565b60006145928235615cfa565b905092915050565b600082601f83011215156145ad57600080fd5b81356145c06145bb82615b93565b615b66565b915081818352602084019350602081019050838560208402820111156145e557600080fd5b60005b8381101561461557816145fb8882614633565b8452602084019350602083019250506001810190506145e8565b5050505092915050565b600061462b8235615d0c565b905092915050565b600061463f8235615d18565b905092915050565b60008083601f840112151561465b57600080fd5b8235905067ffffffffffffffff81111561467457600080fd5b60208301915083600182028301111561468c57600080fd5b9250929050565b600082601f83011215156146a657600080fd5b81356146b96146b482615bbb565b615b66565b915080825260208301602083018583830111156146d557600080fd5b6146e0838284615d7d565b50505092915050565b60006146f58251615d22565b905092915050565b60006147098235615d30565b905092915050565b600061471d8251615d30565b905092915050565b60006147318235615d3a565b905092915050565b60006147458251615d3a565b905092915050565b60006020828403121561475f57600080fd5b600061476d84828501614572565b91505092915050565b60006020828403121561478857600080fd5b600061479684828501614586565b91505092915050565b60008060008060008060008060008060006101208c8e0312156147c157600080fd5b60006147cf8e828f01614572565b9b505060206147e08e828f01614572565b9a505060408c013567ffffffffffffffff8111156147fd57600080fd5b6148098e828f01614647565b9950995050606061481c8e828f016146fd565b975050608061482d8e828f016146fd565b96505060a061483e8e828f016146fd565b95505060c061484f8e828f016146fd565b94505060e08c013567ffffffffffffffff81111561486c57600080fd5b6148788e828f01614647565b935093505061010061488c8e828f016146fd565b9150509295989b509295989b9093969950565b6000602082840312156148b157600080fd5b60006148bf84828501614633565b91505092915050565b600080604083850312156148db57600080fd5b60006148e985828601614633565b92505060206148fa85828601614633565b9150509250929050565b60008060006060848603121561491957600080fd5b600061492786828701614633565b935050602061493886828701614633565b925050604061494986828701614633565b9150509250925092565b6000806000806080858703121561496957600080fd5b600061497787828801614633565b945050602061498887828801614633565b935050604061499987828801614633565b92505060606149aa87828801614633565b91505092959194509250565b600080600080600060a086880312156149ce57600080fd5b60006149dc88828901614633565b95505060206149ed88828901614633565b94505060406149fe88828901614633565b9350506060614a0f88828901614633565b9250506080614a2088828901614633565b9150509295509295909350565b600080600080600060a08688031215614a4557600080fd5b6000614a5388828901614633565b9550506020614a6488828901614633565b9450506040614a7588828901614633565b9350506060614a8688828901614633565b925050608086013567ffffffffffffffff811115614aa357600080fd5b614aaf88828901614693565b9150509295509295909350565b600080600080600060a08688031215614ad457600080fd5b6000614ae288828901614633565b9550506020614af388828901614633565b9450506040614b0488828901614725565b935050606086013567ffffffffffffffff811115614b2157600080fd5b614b2d8882890161459a565b925050608086013567ffffffffffffffff811115614b4a57600080fd5b614b568882890161459a565b9150509295509295909350565b60008060208385031215614b7657600080fd5b600083013567ffffffffffffffff811115614b9057600080fd5b614b9c85828601614647565b92509250509250929050565b600080600080600060808688031215614bc057600080fd5b600086013567ffffffffffffffff811115614bda57600080fd5b614be688828901614647565b95509550506020614bf98882890161461f565b9350506040614c0a888289016146fd565b9250506060614c1b88828901614633565b9150509295509295909350565b600060208284031215614c3a57600080fd5b6000614c48848285016146e9565b91505092915050565b600060208284031215614c6357600080fd5b6000614c71848285016146fd565b91505092915050565b600060208284031215614c8c57600080fd5b6000614c9a84828501614711565b91505092915050565b60008060408385031215614cb657600080fd5b6000614cc4858286016146fd565b9250506020614cd585828601614586565b9150509250929050565b600060208284031215614cf157600080fd5b6000614cff84828501614739565b91505092915050565b614d1181615d47565b82525050565b614d2081615c59565b82525050565b614d2f81615c47565b82525050565b6000614d4082615c01565b808452602084019350614d5283615be7565b60005b82811015614d8457614d68868351614dfa565b614d7182615c2d565b9150602086019550600181019050614d55565b50849250505092915050565b6000614d9b82615c0c565b808452602084019350614dad83615bf4565b60005b82811015614ddf57614dc38683516155a7565b614dcc82615c3a565b9150604086019550600181019050614db0565b50849250505092915050565b614df481615c6b565b82525050565b614e0381615c77565b82525050565b614e1281615c81565b82525050565b6000614e2382615c17565b808452614e37816020860160208601615d8c565b614e4081615dbf565b602085010191505092915050565b6000614e5982615c22565b808452614e6d816020860160208601615d8c565b614e7681615dbf565b602085010191505092915050565b6000601c82527f456e636f64696e67204572726f723a206f666673657420213d20302e000000006020830152604082019050919050565b6000602682527f47534e426f756e636572426173653a2063616c6c6572206973206e6f7420526560208301527f6c617948756200000000000000000000000000000000000000000000000000006040830152606082019050919050565b6000601f82527f43616e6e6f742044454c4554452066726f6d2073797374656d207461626c65006020830152604082019050919050565b6000601a82527f43616e6e6f74205550444154452073797374656d207461626c650000000000006020830152604082019050919050565b6000602682527f4f776e61626c653a206e6577206f776e657220697320746865207a65726f206160208301527f64647265737300000000000000000000000000000000000000000000000000006040830152606082019050919050565b6000601f82527f43616e6e6f7420494e5345525420696e746f2073797374656d207461626c65006020830152604082019050919050565b6000602b82527f47534e436f6e746578743a206e65772052656c6179487562206973207468652060208301527f63757272656e74206f6e650000000000000000000000000000000000000000006040830152606082019050919050565b6000602e82527f4f6e6c79206f776e65722f64656c65676174652063616e20555044415445206960208301527f6e746f2074686973207461626c650000000000000000000000000000000000006040830152606082019050919050565b6000602082527f4572726f723a206b65792065786973747320696e206f7468657220646963742e6020830152604082019050919050565b6000601582527f726f7720616c726561647920686173206f776e657200000000000000000000006020830152604082019050919050565b6000601082527f4572726f7220616c69676e6d656e742e000000000000000000000000000000006020830152604082019050919050565b6000603982527f4e6f7420726f774f776e6572206f72206f776e65722f64656c6567617465206660208301527f6f722055504441544520696e746f2074686973207461626c65000000000000006040830152606082019050919050565b6000602e82527f4f6e6c79206f776e65722f64656c65676174652063616e20494e53455254206960208301527f6e746f2074686973207461626c650000000000000000000000000000000000006040830152606082019050919050565b6000601282527f6572726f722072656d6f76696e67206b657900000000000000000000000000006020830152604082019050919050565b6000602082527f4f776e61626c653a2063616c6c6572206973206e6f7420746865206f776e65726020830152604082019050919050565b6000602e82527f436f6e747261637420696e7374616e63652068617320616c726561647920626560208301527f656e20696e697469616c697a65640000000000000000000000000000000000006040830152606082019050919050565b6000601782527f69642b6669656c6420616c7265616479206578697374730000000000000000006020830152604082019050919050565b6000602e82527f4f6e6c79206f776e65722f64656c65676174652063616e2044454c455445206660208301527f726f6d2074686973207461626c650000000000000000000000000000000000006040830152606082019050919050565b6000602c82527f47534e436f6e746578743a206e65772052656c6179487562206973207468652060208301527f7a65726f206164647265737300000000000000000000000000000000000000006040830152606082019050919050565b6000601382527f496e76616c6964207461626c65207479706521000000000000000000000000006020830152604082019050919050565b6000601482527f5461626c6520616c7265616479206578697374730000000000000000000000006020830152604082019050919050565b6000601082527f696420646f65736e2774206578697374000000000000000000000000000000006020830152604082019050919050565b6000601182527f7461626c65206e6f7420637265617465640000000000000000000000000000006020830152604082019050919050565b6000601382527f4b657920646f6573206e6f7420657869737421000000000000000000000000006020830152604082019050919050565b6000601c82527f696420646f65736e27742065786973742c2075736520494e53455254000000006020830152604082019050919050565b6000601482527f7461626c6520646f6573206e6f742065786973740000000000000000000000006020830152604082019050919050565b6000601782527f53656e646572206e6f74206f776e6572206f6620726f770000000000000000006020830152604082019050919050565b6040820160008201516155bd6000850182614dfa565b5060208201516155d06020850182614dfa565b50505050565b60006040830160008301516155ee6000860182614dfa565b50602083015184820360208601526156068282614d90565b9150508091505092915050565b61561c81615ccd565b82525050565b61562b81615cd7565b82525050565b60006020820190506156466000830184614d26565b92915050565b60006020820190506156616000830184614d08565b92915050565b600060408201905061567c6000830185614d26565b6156896020830184614e09565b9392505050565b600060208201905081810360008301526156aa8184614d35565b905092915050565b60006020820190506156c76000830184614deb565b92915050565b60006020820190506156e26000830184614dfa565b92915050565b600060208201905081810360008301526157028184614e18565b905092915050565b600060208201905081810360008301526157248184614e4e565b905092915050565b6000602082019050818103600083015261574581614e84565b9050919050565b6000602082019050818103600083015261576581614ebb565b9050919050565b6000602082019050818103600083015261578581614f18565b9050919050565b600060208201905081810360008301526157a581614f4f565b9050919050565b600060208201905081810360008301526157c581614f86565b9050919050565b600060208201905081810360008301526157e581614fe3565b9050919050565b600060208201905081810360008301526158058161501a565b9050919050565b6000602082019050818103600083015261582581615077565b9050919050565b60006020820190508181036000830152615845816150d4565b9050919050565b600060208201905081810360008301526158658161510b565b9050919050565b6000602082019050818103600083015261588581615142565b9050919050565b600060208201905081810360008301526158a581615179565b9050919050565b600060208201905081810360008301526158c5816151d6565b9050919050565b600060208201905081810360008301526158e581615233565b9050919050565b600060208201905081810360008301526159058161526a565b9050919050565b60006020820190508181036000830152615925816152a1565b9050919050565b60006020820190508181036000830152615945816152fe565b9050919050565b6000602082019050818103600083015261596581615335565b9050919050565b6000602082019050818103600083015261598581615392565b9050919050565b600060208201905081810360008301526159a5816153ef565b9050919050565b600060208201905081810360008301526159c581615426565b9050919050565b600060208201905081810360008301526159e58161545d565b9050919050565b60006020820190508181036000830152615a0581615494565b9050919050565b60006020820190508181036000830152615a25816154cb565b9050919050565b60006020820190508181036000830152615a4581615502565b9050919050565b60006020820190508181036000830152615a6581615539565b9050919050565b60006020820190508181036000830152615a8581615570565b9050919050565b60006020820190508181036000830152615aa681846155d6565b905092915050565b6000602082019050615ac36000830184615613565b92915050565b6000604082019050615ade6000830185615613565b615aeb6020830184614d26565b9392505050565b6000604082019050615b076000830185615613565b615b146020830184614d17565b9392505050565b6000604082019050615b306000830185615613565b8181036020830152615b428184614e18565b90509392505050565b6000602082019050615b606000830184615622565b92915050565b6000604051905081810181811067ffffffffffffffff82111715615b8957600080fd5b8060405250919050565b600067ffffffffffffffff821115615baa57600080fd5b602082029050602081019050919050565b600067ffffffffffffffff821115615bd257600080fd5b601f19601f8301169050602081019050919050565b6000602082019050919050565b6000602082019050919050565b600081519050919050565b600081519050919050565b600081519050919050565b600081519050919050565b6000602082019050919050565b6000602082019050919050565b6000615c5282615cad565b9050919050565b6000615c6482615cad565b9050919050565b60008115159050919050565b6000819050919050565b60007fffffffff0000000000000000000000000000000000000000000000000000000082169050919050565b600073ffffffffffffffffffffffffffffffffffffffff82169050919050565b6000819050919050565b600064ffffffffff82169050919050565b6000615cf382615cad565b9050919050565b6000615d0582615cad565b9050919050565b60008115159050919050565b6000819050919050565b600061ffff82169050919050565b6000819050919050565b600060ff82169050919050565b6000615d5282615d59565b9050919050565b6000615d6482615d6b565b9050919050565b6000615d7682615cad565b9050919050565b82818337600083830152505050565b60005b83811015615daa578082015181840152602081019050615d8f565b83811115615db9576000848401525b50505050565b6000601f19601f830116905091905056fea265627a7a72305820ff8cf2bee6c65ce1b61259b8bf1a6b74384f8ff08cb8ad1cd247e3d7877932b96c6578706572696d656e74616cf50037";
var compiler = {
	name: "solc",
	version: "0.5.0+commit.1d4f565a.Emscripten.clang",
	optimizer: {
		enabled: false,
		runs: 200
	},
	evmVersion: "byzantium"
};
var networks = {
	"3": {
		links: {
		},
		events: {
		},
		address: "0x43D747Ec61A73FA1eE8bB7ED6dED4a42F01085d3",
		updated_at: 1586994108459
	},
	"1585998008507": {
		links: {
		},
		events: {
		},
		address: "0x6eD79Aa1c71FD7BdBC515EfdA3Bd4e26394435cC",
		updated_at: 1586000828148
	},
	"1586011004637": {
		links: {
		},
		events: {
		},
		address: "0xc22Ffa318051d8aF4E5f2E2732d7049486fcE093",
		updated_at: 1586076696505
	},
	"1586077022249": {
		links: {
		},
		events: {
		},
		address: "0xf5288515FD1394B814e38293f41dC22ad8085532",
		updated_at: 1586078222281
	},
	"1586078282048": {
		links: {
		},
		events: {
		},
		address: "0xBc53027c52B0Ee6ad90347b8D03A719f30d9d7aB",
		updated_at: 1586079473220
	},
	"1586220713610": {
		links: {
		},
		events: {
		},
		address: "0x32B283164B5A283A01208CA894b534b9eA9C4632",
		updated_at: 1586237928784
	},
	"1586238448586": {
		links: {
		},
		events: {
		},
		address: "0x0b19679bdEBA8Ae070534dA587cd4161D0053d75",
		updated_at: 1586242201453
	},
	"1586253728867": {
		links: {
		},
		events: {
		},
		address: "0x3a936D6Ec8e28f7254A1603D33d040eE044a8340",
		updated_at: 1586266128230
	},
	"1586267134607": {
		links: {
		},
		events: {
		},
		address: "0x9F1Cdfa4501a5B601E39141B1dF10B4ba3EAB978",
		updated_at: 1586269322701
	},
	"1586273268014": {
		links: {
		},
		events: {
		},
		address: "0x1fF052905302eBbB1Ea38648c588B5F0826c655f",
		updated_at: 1586284007229
	},
	"1586344166328": {
		links: {
		},
		events: {
		},
		address: "0xFdE7611924484765d4BAbeBd0a37Dc1d43c193C5",
		updated_at: 1586344472249
	},
	"1586427421260": {
		links: {
		},
		events: {
		},
		address: "0xF6ae1A8bD48307609353388fFB0ab91dC7cc28C1",
		updated_at: 1586436228998
	},
	"1586452175809": {
		links: {
		},
		events: {
		},
		address: "0x4F2e7A845cDbe0a6957C30D9051e453dA1838261",
		updated_at: 1586452194216
	},
	"1586458717203": {
		links: {
		},
		events: {
		},
		address: "0x09662026534c93C0e36187110f6c6508D7c82654",
		updated_at: 1586458815291
	},
	"1586501942236": {
		links: {
		},
		events: {
		},
		address: "0xCD7D03cf805c633DeA6FC3E7522d343A8caAD9Cb",
		updated_at: 1586516562199
	},
	"1586518076316": {
		links: {
		},
		events: {
		},
		address: "0x4817a0Cf1016069a0b17B77d16bdF64B5243003B",
		updated_at: 1586519769536
	},
	"1586519899574": {
		links: {
		},
		events: {
		},
		address: "0xA3d11db1823547b6434b3e821d14b58d9dDD819E",
		updated_at: 1586524521697
	},
	"1586525870458": {
		links: {
		},
		events: {
		},
		address: "0x1E57ccB526292cCaD5255982000A280Ea7F8259b",
		updated_at: 1586546908167
	},
	"1586589955485": {
		links: {
		},
		events: {
		},
		address: "0x8096f0c657B1111caaBE7059e7DE2E9428d7Ca26",
		updated_at: 1586599421761
	},
	"1586681824745": {
		links: {
		},
		events: {
		},
		address: "0x592c129085b61A3110Ebd1DCD99F3Cfe97A54dF3",
		updated_at: 1586688748031
	},
	"1586716667226": {
		links: {
		},
		events: {
		},
		address: "0xab8A1078d984C20A8646A3cEA960A29586D48631",
		updated_at: 1586726798182
	},
	"1586765761638": {
		links: {
		},
		events: {
		},
		address: "0x65fcf441f00395A5649c05E5c81fC6Fad463FFc1",
		updated_at: 1586768342468
	},
	"1586780448303": {
		links: {
		},
		events: {
		},
		address: "0x7593B6cd2DA98aa575DB77Aef358f0853559aF83",
		updated_at: 1586780480702
	},
	"1586791657977": {
		links: {
		},
		events: {
		},
		address: "0x9Eabad7BEf5Dd7CDeCc8cc954ae391D15d668f8f",
		updated_at: 1586802772990
	},
	"1586896685537": {
		links: {
		},
		events: {
		},
		address: "0x117460c5aE4Fb538C344778ebD9Ca4923d22A38e",
		updated_at: 1586900596283
	},
	"1586987389907": {
		links: {
		},
		events: {
		},
		address: "0x78A9b2871462cdA05A9b82b20262487bAa70d11c",
		updated_at: 1586994802571
	},
	"1587016996544": {
		links: {
		},
		events: {
		},
		address: "0xf759A0e8F2fFBb5F5a9DD50f1106668FBE29bC93",
		updated_at: 1587017068769
	},
	"1587085748924": {
		links: {
		},
		events: {
		},
		address: "0x59d3631c86BbE35EF041872d502F218A39FBa150",
		updated_at: 1587085888987
	}
};
var ELAJSStoreJSON = {
	fileName: fileName,
	contractName: contractName,
	source: source,
	sourcePath: sourcePath,
	sourceMap: sourceMap,
	deployedSourceMap: deployedSourceMap,
	abi: abi,
	ast: ast,
	bytecode: bytecode,
	deployedBytecode: deployedBytecode,
	compiler: compiler,
	networks: networks
};

/**
 * TODO: consistent returns of promise
 * - Must support ephemeral (anonymous calls)
 * - Needs to have a way to connect to Fortmatic
 * - Do we expect the parent app to pass in the ozWeb3 and fmWeb3?
 * - do we track state and an entire table schema? cached?
 * - web3 should definitely be external, we pass it in and instantiate the contract
 */

var ELA_JS = /*#__PURE__*/function () {
  /**
   *
   * @param options
   */
  function ELA_JS(options) {
    _classCallCheck(this, ELA_JS);

    console.log('constructor');
    /*
    ************************************************************************************************************
    * Passed In
    ************************************************************************************************************
     */

    this.contractAddress = options.contractAddress;
    /*
     This could be 1 of 2 possibilities
     1. The storage contract owner is running in a secure env and this is the owner of the storage contract.
        However for most of the developers they will have a Fortmatic account and need to export the priv key
        to take advantage of this, so they will be stuck using the ElastosJS GUI or import this into a custom
        app.
      2. This is deployed and the user is not the owner, most likely case.
     */

    this.defaultWeb3 = options.defaultWeb3; // this is the ephemeral signer for anonymous calls which don't prompt for a signature

    this.ephemeralWeb3 = options.ephemeralWeb3;
    /*
    ************************************************************************************************************
    * Internal
    ************************************************************************************************************
     */
    // default instance - points to ElastosJS contract

    this.defaultInstance = null; // ephemeral instance - points to ElastosJS contract

    this.ephemeralInstance = null;
    this.ozWeb3 = null;
    this.fmWeb3 = null;
    this.schema = {};
    this.contractABI = ELAJSStoreJSON.abi;
    this.contractBytecode = ELAJSStoreJSON.bytecode;
    this.config = {
      gasPrice: '1000000000'
    };
    this.debug = true;

    this._initialize();
  }
  /**
   * We should setup the web3 components if not passed in
   * @private
   */


  _createClass(ELA_JS, [{
    key: "_initialize",
    value: function _initialize() {
      if (this.defaultWeb3 && this.contractAddress) {
        this.defaultInstance = new this.defaultWeb3.eth.Contract(this.contractABI, this.contractAddress);
      }

      if (this.ephemeralWeb3 && this.contractAddress) {
        // the ozWeb3 is constructed slightly differently
        this.ephemeralInstance = new this.ephemeralWeb3.lib.eth.Contract(this.contractABI, this.contractAddress);
      } // 1. fetch table list
      // 2. lazy fetch schema?

    }
  }, {
    key: "setDatabase",
    value: function setDatabase(contractAddress) {
      this.contractAddress = contractAddress;
      this.defaultInstance = new this.defaultWeb3.eth.Contract(this.contractABI, contractAddress);
      this.ephemeralInstance = new this.ephemeralWeb3.lib.eth.Contract(this.contractABI, contractAddress);
    }
  }, {
    key: "deployDatabase",
    value: function deployDatabase(ethAddress) {
      var newContract = new this.defaultWeb3.eth.Contract(this.contractABI);
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
      });
    }
  }, {
    key: "initializeContract",
    value: function initializeContract(ethAddress) {
      return this.defaultInstance.methods.initialize().send({
        useGSN: false,
        from: ethAddress,
        gasPrice: this.config.gasPrice
      });
    } // fm call only
    // we pass in ethAddress because we don't wait to wait for a fortmatic async fetch for ethAccounts

  }, {
    key: "createTable",
    value: function createTable(tableName, permission, cols, colTypes, ethAddress) {
      var tableNameValue = Web3.utils.stringToHex(tableName);
      var tableKey = namehash(tableName);

      if (this.debug) {
        console.log('createTable', tableKey);
        console.log(tableNameValue); // this should only work locally, fortmatic would use a different path

        console.log(this.defaultWeb3.eth.personal.currentProvider.addresses[0]);
        console.log('gasPrice', this.config.gasPrice);
      }

      return this.defaultInstance.methods.createTable(tableNameValue, tableKey, permission, cols, colTypes).send({
        from: ethAddress || this.defaultWeb3.eth.personal.currentProvider.addresses[0],
        gasPrice: this.config.gasPrice
      });
    }
  }, {
    key: "getTables",
    value: function () {
      var _getTables = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime.mark(function _callee() {
        return _regeneratorRuntime.wrap(function _callee$(_context) {
          while (1) {
            switch (_context.prev = _context.next) {
              case 0:
                _context.next = 2;
                return this.ephemeralInstance.methods.getTables().call();

              case 2:
                return _context.abrupt("return", _context.sent);

              case 3:
              case "end":
                return _context.stop();
            }
          }
        }, _callee, this);
      }));

      function getTables() {
        return _getTables.apply(this, arguments);
      }

      return getTables;
    }()
  }, {
    key: "getTableMetadata",
    value: function () {
      var _getTableMetadata = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime.mark(function _callee2(tableName) {
        var tableKey;
        return _regeneratorRuntime.wrap(function _callee2$(_context2) {
          while (1) {
            switch (_context2.prev = _context2.next) {
              case 0:
                tableKey = namehash(tableName);
                _context2.next = 3;
                return this.ephemeralInstance.methods.getTableMetadata(tableKey).call();

              case 3:
                return _context2.abrupt("return", _context2.sent);

              case 4:
              case "end":
                return _context2.stop();
            }
          }
        }, _callee2, this);
      }));

      function getTableMetadata(_x) {
        return _getTableMetadata.apply(this, arguments);
      }

      return getTableMetadata;
    }()
  }, {
    key: "getTableSchema",
    value: function () {
      var _getTableSchema = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime.mark(function _callee3(tableName) {
        var tableKey;
        return _regeneratorRuntime.wrap(function _callee3$(_context3) {
          while (1) {
            switch (_context3.prev = _context3.next) {
              case 0:
                tableKey = namehash(tableName);
                _context3.next = 3;
                return this.ephemeralInstance.methods.getSchema(tableKey).call();

              case 3:
                return _context3.abrupt("return", _context3.sent);

              case 4:
              case "end":
                return _context3.stop();
            }
          }
        }, _callee3, this);
      }));

      function getTableSchema(_x2) {
        return _getTableSchema.apply(this, arguments);
      }

      return getTableSchema;
    }()
  }, {
    key: "getTableIds",
    value: function () {
      var _getTableIds = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime.mark(function _callee4(tableName) {
        var tableKey;
        return _regeneratorRuntime.wrap(function _callee4$(_context4) {
          while (1) {
            switch (_context4.prev = _context4.next) {
              case 0:
                tableKey = namehash(tableName);
                _context4.next = 3;
                return this.ephemeralInstance.methods.getTableIds(tableKey).call();

              case 3:
                return _context4.abrupt("return", _context4.sent);

              case 4:
              case "end":
                return _context4.stop();
            }
          }
        }, _callee4, this);
      }));

      function getTableIds(_x3) {
        return _getTableIds.apply(this, arguments);
      }

      return getTableIds;
    }()
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

  }, {
    key: "insertRow",
    value: function () {
      var _insertRow = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime.mark(function _callee5(tableName, cols, values, options) {
        var id, _this$_getKeys, idKey, tableKey, i, fieldIdTableKey, fieldKey;

        return _regeneratorRuntime.wrap(function _callee5$(_context5) {
          while (1) {
            switch (_context5.prev = _context5.next) {
              case 0:
                if (!(options && options.id && (options.id.substring(0, 2) !== '0x' || options.id.length !== 66))) {
                  _context5.next = 2;
                  break;
                }

                throw new Error('options.id must be a 32 byte hex string prefixed with 0x');

              case 2:
                if (!(cols.length !== values.length)) {
                  _context5.next = 4;
                  break;
                }

                throw new Error('cols, values arrays must be same length');

              case 4:
                id = Web3.utils.randomHex(32);

                if (options && options.id) {
                  id = options.id;
                }

                _this$_getKeys = this._getKeys(tableName, id.substring(2)), idKey = _this$_getKeys.idKey, tableKey = _this$_getKeys.tableKey; // TODO: check cache for table schema? Be lazy for now and always check?

                i = 0;

              case 8:
                if (!(i < cols.length)) {
                  _context5.next = 17;
                  break;
                }

                fieldIdTableKey = namehash("".concat(cols[i], ".").concat(id.substring(2), ".").concat(tableName));
                console.log("fieldIdTableKey = ".concat(fieldIdTableKey));
                fieldKey = keccak256(cols[i]);
                _context5.next = 14;
                return this.ephemeralInstance.methods.insertVal(tableKey, idKey, fieldKey, id, values[i]).send({
                  from: this.ephemeralWeb3.accounts[0]
                });

              case 14:
                i++;
                _context5.next = 8;
                break;

              case 17:
              case "end":
                return _context5.stop();
            }
          }
        }, _callee5, this);
      }));

      function insertRow(_x4, _x5, _x6, _x7) {
        return _insertRow.apply(this, arguments);
      }

      return insertRow;
    }()
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

  }, {
    key: "insertVal",
    value: function insertVal(tableName, col, val, options) {
      if (options && options.id && (options.id.substring(0, 2) !== '0x' || options.id.length !== 66)) {
        throw new Error('options.id must be a 32 byte hex string prefixed with 0x');
      }

      var id = Web3.utils.randomHex(32);

      if (options && options.id) {
        id = options.id;
      }

      var _this$_getKeys2 = this._getKeys(tableName, id.substring(2)),
          idKey = _this$_getKeys2.idKey,
          tableKey = _this$_getKeys2.tableKey;

      var fieldIdTableKey = namehash("".concat(col, ".").concat(id.substring(2), ".").concat(tableName));
      console.log("fieldIdTableKey = ".concat(fieldIdTableKey));
      var fieldKey = keccak256(col);
      return this.ephemeralInstance.methods.insertVal(tableKey, idKey, fieldKey, id, val).send({
        from: this.ephemeralWeb3.accounts[0]
      });
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

  }, {
    key: "_getVal",
    value: function _getVal(tableName, id, fieldName) {
      if (id.substring(0, 2) !== '0x' || id.length !== 66) {
        throw new Error('id must be a 32 byte hex string prefixed with 0x');
      } // always strip the 0x


      id = id.substring(2);
      var fieldIdTableKey = namehash("".concat(fieldName, ".").concat(id, ".").concat(tableName));
      var result = this.ephemeralInstance.methods.getRowValue(fieldIdTableKey).call(); // TODO: type parsing? How to ensure this is fresh?
      // and so what if it isn't? We can't really change a field type right?
      // const fieldType = this.schema[tableKey][fieldKey].type

      /*
      switch (fieldType) {
         case constants.FIELD_TYPE.NUMBER:
          result = Web3.utils.hexToNumber(result)
          break
      }
       */

      return result;
    }
    /**
     * Update a single val, should be called by another fn
     * @private
     */

  }, {
    key: "_updateVal",
    value: function _updateVal() {}
  }, {
    key: "deleteRow",
    value: function deleteRow() {}
  }, {
    key: "getGSNBalance",
    value: function () {
      var _getGSNBalance = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime.mark(function _callee6() {
        return _regeneratorRuntime.wrap(function _callee6$(_context6) {
          while (1) {
            switch (_context6.prev = _context6.next) {
              case 0:
                _context6.next = 2;
                return this.ephemeralInstance.methods.getGSNBalance().call();

              case 2:
                return _context6.abrupt("return", _context6.sent);

              case 3:
              case "end":
                return _context6.stop();
            }
          }
        }, _callee6, this);
      }));

      function getGSNBalance() {
        return _getGSNBalance.apply(this, arguments);
      }

      return getGSNBalance;
    }()
    /*
    ************************************************************************************************************
    * Internal
    ************************************************************************************************************
     */

  }, {
    key: "_getKeys",
    value: function _getKeys(tableName, id) {
      if (id.substring(0, 2) === '0x') {
        throw new Error('internal fn _getKeys expects id without 0x prefix');
      }

      var idKey = keccak256(id);
      var tableKey = namehash(tableName);
      var idTableKey = namehash("".concat(id, ".").concat(tableName));
      return {
        idKey: idKey,
        tableKey: tableKey,
        idTableKey: idTableKey
      };
    }
    /*
     ******************************************************************************************************
     * Query Functions
     ******************************************************************************************************
     */

    /**
     * Returns a chainable select object, that finally resolves to a callable Promise
     */

  }, {
    key: "select",
    value: function select() {// return this? - need to instantiate and return a new Class instance for chaining
      // pass a reference to elajs into the constructor?
    }
  }]);

  return ELA_JS;
}();

function ownKeys(object, enumerableOnly) { var keys = Object.keys(object); if (Object.getOwnPropertySymbols) { var symbols = Object.getOwnPropertySymbols(object); if (enumerableOnly) symbols = symbols.filter(function (sym) { return Object.getOwnPropertyDescriptor(object, sym).enumerable; }); keys.push.apply(keys, symbols); } return keys; }

function _objectSpread(target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i] != null ? arguments[i] : {}; if (i % 2) { ownKeys(Object(source), true).forEach(function (key) { _defineProperty(target, key, source[key]); }); } else if (Object.getOwnPropertyDescriptors) { Object.defineProperties(target, Object.getOwnPropertyDescriptors(source)); } else { ownKeys(Object(source)).forEach(function (key) { Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(source, key)); }); } } return target; }

var exports = _objectSpread({
  ELA_JS: ELA_JS,
  namehash: namehash,
  keccak256: keccak256
}, bytesToTypes, {}, typesToBytes);

export default exports;
