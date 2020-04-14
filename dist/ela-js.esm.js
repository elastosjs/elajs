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
var source = "pragma solidity ^0.5.0;\npragma experimental ABIEncoderV2;\n\nimport \"sol-datastructs/src/contracts/PolymorphicDictionaryLib.sol\";\n\n// import \"sol-datastructs/src/contracts/Bytes32DictionaryLib.sol\";\nimport \"sol-datastructs/src/contracts/Bytes32SetDictionaryLib.sol\";\n\n// import \"./oz/EnumerableSetDictionary.sol\";\n\nimport \"sol-sql/src/contracts/src/structs/TableLib.sol\";\n\nimport \"./ozEla/OwnableELA.sol\";\nimport \"./gsnEla/GSNRecipientELA.sol\";\nimport \"./gsnEla/IRelayHubELA.sol\";\n\ncontract DateTime {\n    function getYear(uint timestamp) public pure returns (uint16);\n    function getMonth(uint timestamp) public pure returns (uint8);\n    function getDay(uint timestamp) public pure returns (uint8);\n}\n\n// TODO: good practice to have functions not callable externally and internally\ncontract ELAJSStore is OwnableELA, GSNRecipientELA {\n\n    // DateTime Contract address\n    // address public dateTimeAddr = 0x9c71b2E820B067ea466ea81C0cd6852Bc8D8604e; // development\n    address constant public dateTimeAddr = 0xEDb211a2dBbdE62012440177e65b68E0A66E4531; // testnet\n\n    // Initialize the DateTime contract ABI with the already deployed contract\n    DateTime dateTime = DateTime(dateTimeAddr);\n\n    // This counts the number of times this contract was called via GSN (expended owner gas) for rate limiting\n    // mapping is a keccak256('YYYY-MM-DD') => uint (TODO: we can probably compress this by week (4 bytes per day -> 28 bytes)\n    mapping(bytes32 => uint256) public gsnCounter;\n\n    // Max times we allow this to be called per day\n    uint40 public gsnMaxCallsPerDay;\n\n    using PolymorphicDictionaryLib for PolymorphicDictionaryLib.PolymorphicDictionary;\n    using Bytes32SetDictionaryLib for Bytes32SetDictionaryLib.Bytes32SetDictionary;\n\n    // _table = system table (bytes32 Dict) of each table's metadata marshaled\n    // 8 bits - permissions (00 = system, 01 = private, 10 = public, 11 = shared - owner can always edit)\n    // 20 bytes - address delegate - other address allowed to edit\n    mapping(bytes32 => bytes32) internal _table;\n\n    // table = dict, where the key is the table, and the value is a set of byte32 ids\n    Bytes32SetDictionaryLib.Bytes32SetDictionary internal tableId;\n\n    // Schema dictionary, key (schemasPublicTables) points to a set of table names\n    using TableLib for TableLib.Table;\n    using TableLib for bytes;\n    // using ColumnLib for ColumnLib.Column;\n    // using ColumnLib for bytes;\n\n    // schemaTables -> Set of tables (raw table name values) for enumeration\n    bytes32 constant public schemasTables = 0x736368656d61732e7075626c69632e7461626c65730000000000000000000000;\n\n    // namehash([tableName]) => encoded table schema\n    // ownership of each row (id) - key = namehash([id].[table]) which has a value that is the owner's address\n    // ultimately namehash([field].[id].[table]) gives us a bytes32 which maps to the single data value\n    PolymorphicDictionaryLib.PolymorphicDictionary internal database;\n\n\n    // ************************************* SETUP FUNCTIONS *************************************\n    function initialize() public initializer {\n        OwnableELA.initialize(msg.sender);\n        GSNRecipientELA.initialize();\n        _initialize();\n    }\n\n    function _initialize() internal {\n        gsnMaxCallsPerDay = 1000;\n\n        // init the key for schemasTables, our set is one-to-many-fixed, so table names must be max 32 bytes\n        database.addKey(schemasTables, PolymorphicDictionaryLib.DictionaryType.OneToManyFixed);\n    }\n\n    // ************************************* SCHEMA FUNCTIONS *************************************\n    /**\n     * @dev create a new table, only the owner may create this\n     *\n     * @param tableName right padded zeroes (Web3.utils.stringToHex)\n     * @param tableKey this is the namehash of tableName\n     */\n    function createTable(\n        bytes32 tableName,\n        bytes32 tableKey,\n        uint8 permission,\n        bytes32[] memory _columnName,\n        bytes32[] memory _columnDtype\n\n    ) public onlyOwner {\n\n        // this only works if tableName is trimmed of padding zeroes, since this is an onlyOwner call we won't bother\n        // require(isNamehashSubOf(keccak256(tableNameBytes), bytes32(0), tableKey), \"tableName does not match tableKey\");\n\n        // check if table exists\n        require(_table[tableKey] == 0, \"Table already exists\");\n\n        address delegate = address(0x0);\n\n        // claim the key slot and set the metadata\n        setTableMetadata(tableKey, permission, delegate);\n\n        database.addValueForKey(schemasTables, tableName);\n\n        // table stores the row ids set as the value, set up the key\n        tableId.addKey(tableKey);\n\n        // now insert the schema\n        TableLib.Table memory tableSchema = TableLib.create(\n            tableName,\n            _columnName,\n            _columnDtype\n        );\n\n        saveSchema(tableKey, tableSchema);\n    }\n\n    // TODO: this isn't complete\n    function deleteTable(\n        bytes32 tableName,\n        bytes32 tableKey\n    ) public onlyOwner {\n        database.removeValueForKey(schemasTables, tableName);\n        tableId.removeKey(tableKey);\n    }\n\n    /*\n    function tableExists(bytes32 tableKey) public view returns (bool) {\n        return tableId.containsKey(tableKey);\n    }\n    */\n\n    function saveSchema(bytes32 tableKey, TableLib.Table memory tableSchema) internal returns (bool) {\n        bytes memory encoded = tableSchema.encode();\n\n        // we store the encoded table schema on the base tableKey\n        return database.setValueForKey(tableKey, encoded);\n    }\n\n    // EXPERIMENTAL\n    function getSchema(bytes32 _name) public view returns (TableLib.Table memory) {\n        bytes memory encoded = database.getBytesForKey(_name);\n        return encoded.decodeTable();\n    }\n\n    // ************************************* CRUD FUNCTIONS *************************************\n\n    /**\n     * @dev Table level permission checks\n     */\n    modifier insertCheck(bytes32 tableKey, bytes32 idKey, bytes32 idTableKey) {\n\n        (uint256 permission, address delegate) = getTableMetadata(tableKey);\n\n        // if permission = 0, system table we can't do anything\n        require(permission > 0, \"Cannot INSERT into system table\");\n\n        // if permission = 1, we must be the owner/delegate\n        require(permission > 1 || isOwner() == true || delegate == _msgSender(), \"Only owner/delegate can INSERT into this table\");\n\n        // permissions check, is the idTableKey a subhash of the id and table?\n        require(isNamehashSubOf(idKey, tableKey, idTableKey) == true, \"idTableKey not a subhash [id].[table]\");\n\n        _;\n    }\n\n    /**\n     * @dev Prior to insert, we check the permissions and autoIncrement\n     * TODO: use the schema and determine the proper type of data to insert\n     *\n     * @param tableKey the namehashed [table] name string\n     * @param idKey the sha3 hashed idKey\n     * @param idTableKey the namehashed [id].[table] name string\n     *\n     * @param id as the raw string (unhashed)\n     *\n     *\n     */\n    function insertVal(\n\n        bytes32 tableKey,\n        bytes32 idTableKey,\n        bytes32 fieldIdTableKey,\n\n        bytes32 idKey,\n        bytes32 fieldKey,\n\n        bytes32 id,\n        bytes32 val)\n\n    public insertCheck(tableKey, idKey, idTableKey){\n\n        require(database.containsKey(fieldIdTableKey) == false, \"id+field already exists\");\n\n        // now check if the full field + id + table is a subhash\n        require(isNamehashSubOf(fieldKey, idTableKey, fieldIdTableKey) == true, \"fieldKey not a subhash [field].[id].[table]\");\n\n        // increment counter\n        increaseGsnCounter();\n\n        // add an id entry to the table's set of ids for the row (this is a set so we don't need to check first)\n        tableId.addValueForKey(tableKey, id);\n\n        // add the \"row owner\" if it doesn't exist, the row may already exist in which case we don't update it\n        if (database.containsKey(idTableKey) == false){\n            _setRowOwner(idTableKey, id, tableKey);\n        }\n\n        // finally set the data\n        // we won't serialize the type, that's way too much redundant data\n        database.setValueForKey(fieldIdTableKey, bytes32(val));\n\n    }\n\n    /*\n    function insertValVar(\n        bytes32 tableKey,\n        bytes32 idTableKey,\n        bytes32 fieldIdTableKey,\n\n        bytes32 idKey,\n        bytes32 fieldKey,\n\n        bytes32 id,\n        bytes memory val)\n\n    public insertCheck(tableKey, idKey, idTableKey){\n\n        require(database.containsKey(fieldIdTableKey) == false, \"id+field already exists\");\n\n        // now check if the full field + id + table is a subhash\n        require(isNamehashSubOf(fieldKey, idTableKey, fieldIdTableKey) == true, \"fieldKey not a subhash [field].[id].[table]\");\n\n        // increment counter\n        increaseGsnCounter();\n\n        // add an id entry to the table's set of ids for the row\n        tableId.addValueForKey(tableKey, id);\n\n        // finally set the data\n        database.setValueForKey(fieldIdTableKey, val);\n    }\n    */\n\n    /**\n     * @dev we are essentially claiming this [id].[table] for the msg.sender, and setting the id createdDate\n     */\n    function _setRowOwner(bytes32 idTableKey, bytes32 id, bytes32 tableKey) internal {\n\n        require(database.containsKey(idTableKey) == false, \"row already has owner\");\n\n        uint256 rowMetadata;\n\n        uint16 year = dateTime.getYear(now);\n        uint8 month = dateTime.getMonth(now);\n        uint8 day = dateTime.getDay(now);\n\n        rowMetadata |= year;\n        rowMetadata |= uint256(month)<<16;\n        rowMetadata |= uint256(day)<<24;\n\n        bytes4 createdDate = bytes4(uint32(rowMetadata));\n\n        rowMetadata |= uint256(_msgSender())<<32;\n\n        database.setValueForKey(idTableKey, bytes32(rowMetadata));\n\n        emit InsertRow(id, tableKey, _msgSender());\n    }\n\n    event InsertRow (\n        bytes32 indexed _id,\n        bytes32 indexed _tableKey,\n        address indexed _rowOwner\n    );\n\n    function getRowOwner(bytes32 idTableKey) external returns (address rowOwner, bytes4 createdDate){\n\n        uint256 rowMetadata = uint256(database.getBytes32ForKey(idTableKey));\n\n        createdDate = bytes4(uint32(rowMetadata));\n        rowOwner = address(rowMetadata>>32);\n\n    }\n\n    modifier updateCheck(bytes32 tableKey, bytes32 idKey, bytes32 idTableKey) {\n\n        (uint256 permission, address delegate) = getTableMetadata(tableKey);\n\n        // if permission = 0, system table we can't do anything\n        require(permission > 0, \"Cannot UPDATE system table\");\n\n        // if permission = 1, we must be the owner/delegate\n        require(permission > 1 || isOwner() == true || delegate == _msgSender(), \"Only owner/delegate can UPDATE into this table\");\n\n        // permissions check, is the idTableKey a subhash of the id and table?\n        require(isNamehashSubOf(idKey, tableKey, idTableKey) == true, \"idTableKey not a subhash [id].[table]\");\n\n        // permissions check (public table = 2, shared table = 3),\n        // if 2 or 3 is the _msg.sender() the row owner? But if 3 owner() is always allowed\n        if (permission >= 2) {\n\n            // rowMetaData is packed as address (bytes20) + createdDate (bytes4)\n            bytes32 rowMetaData = database.getBytes32ForKey(idTableKey);\n            address rowOwner = address(uint256(rowMetaData)>>32);\n\n            // if either 2 or 3, if you're the row owner it's fine\n            if (rowOwner == _msgSender()){\n                // pass\n            } else {\n                require(isOwner() == true || delegate == _msgSender(), \"Not rowOwner or owner/delegate for UPDATE into this table\");\n            }\n\n        }\n        _;\n    }\n\n    function updateVal(\n\n        bytes32 tableKey,\n        bytes32 idTableKey,\n        bytes32 fieldIdTableKey,\n\n        bytes32 idKey,\n        bytes32 fieldKey,\n\n        bytes32 id,\n        bytes32 val)\n\n    public updateCheck(tableKey, idKey, idTableKey) {\n\n        require(tableId.containsValueForKey(tableKey, id) == true, \"id doesn't exist, use INSERT\");\n\n        // now check if the full field + id + table is a subhash\n        require(isNamehashSubOf(fieldKey, idTableKey, fieldIdTableKey) == true, \"fieldKey not a subhash [field].[id].[table]\");\n\n        // increment counter\n        increaseGsnCounter();\n\n        // set data (overwrite)\n        database.setValueForKey(fieldIdTableKey, bytes32(val));\n\n    }\n\n    modifier deleteCheck(bytes32 tableKey, bytes32 idTableKey, bytes32 idKey, bytes32 id) {\n\n        require(tableId.containsValueForKey(tableKey, id) == true, \"id doesn't exist\");\n\n        (uint256 permission, address delegate) = getTableMetadata(tableKey);\n\n        // if permission = 0, system table we can't do anything\n        require(permission > 0, \"Cannot DELETE from system table\");\n\n        // if permission = 1, we must be the owner/delegate\n        require(permission > 1 || isOwner() == true || delegate == _msgSender(), \"Only owner/delegate can DELETE from this table\");\n\n        // permissions check, is the idTableKey a subhash of the id and table?\n        require(isNamehashSubOf(idKey, tableKey, idTableKey) == true, \"idTableKey not a subhash [id].[table]\");\n\n        // permissions check (public table = 2, shared table = 3),\n        // if 2 or 3 is the _msg.sender() the row owner? But if 3 owner() is always allowed\n        if (permission >= 2) {\n            if (isOwner() || delegate == _msgSender()){\n                // pass\n            } else {\n                // rowMetaData is packed as address (bytes20) + createdDate (bytes4)\n                bytes32 rowMetaData = database.getBytes32ForKey(idTableKey);\n                address rowOwner = address(uint256(rowMetaData)>>32);\n                require(rowOwner == _msgSender(), \"Sender not owner of row\");\n            }\n        }\n\n        _;\n    }\n\n    /**\n     * @dev TODO: add modifier checks based on update\n     *\n     * TODO: this needs to properly remove the row when there are multiple ids\n     *\n     */\n    function deleteVal(\n\n        bytes32 tableKey,\n        bytes32 idTableKey,\n\n        bytes32 idKey,\n        bytes32 id,\n\n        bytes32 fieldKey,\n        bytes32 fieldIdTableKey\n\n    ) public deleteCheck(tableKey, idTableKey, idKey, id){\n\n        // check if the full field + id + table is a subhash (permissions)\n        require(isNamehashSubOf(fieldKey, idTableKey, fieldIdTableKey) == true, \"fieldKey not a subhash [field].[id].[table]\");\n\n        // increment counter\n        increaseGsnCounter();\n\n        // remove the key\n        bool removed = database.removeKey(fieldIdTableKey);\n\n        require(removed == true, \"error removing key\");\n\n        // TODO: zero out the data? Why bother everything is public\n\n        // we can't really pass in enough data to make a loop worthwhile\n        /*\n        uint8 len = uint8(fieldKeys.length);\n        require(fieldKeys.length == fieldIdTableKeys.length, \"fields, id array length mismatch\");\n        for (uint8 i = 0; i < len; i++) {\n\n            // for each row check if the full field + id + table is a subhash\n            // require(isNamehashSubOf(fieldKeys[i], idTableKey, fieldIdTableKeys[i]) == true, \"fieldKey not a subhash [field].[id].[table]\");\n\n            // zero out the data\n            elajsStore[fieldIdTableKeys[i]] = bytes32(0);\n        }\n        */\n    }\n\n    // TODO: improve this, we don't want to cause data consistency if the client doesn't call this\n    // Right now we manually call this, but ideally we iterate over all the data and delete each column\n    // but this would require decoding and having all the field names\n    function deleteRow(\n\n        bytes32 tableKey,\n        bytes32 idTableKey,\n\n        bytes32 idKey,\n        bytes32 id\n\n    ) public deleteCheck(tableKey, idTableKey, idKey, id){\n\n        // increment counter\n        increaseGsnCounter();\n\n        // remove the id\n        tableId.removeValueForKey(tableKey, id);\n    }\n\n    /**\n     * @dev Table actual insert call, NOTE this doesn't work on testnet currently due to a stack size issue,\n     *      but it can work with a paid transaction I guess\n     */\n    /*\n    function insert(\n        bytes32 tableKey,\n        bytes32 idTableKey,\n\n        bytes32 idKey,\n        bytes32 id,\n\n        bytes32[] memory fieldKeys,\n        bytes32[] memory fieldIdTableKeys,\n        bytes32[] memory values)\n\n    public insertCheck(tableKey, idKey, idTableKey){\n\n        require(table.containsValueForKey(tableKey, id) == false, \"id already exists\");\n\n        uint len = fieldKeys.length;\n\n        require(fieldKeys.length == fieldIdTableKeys.length == values.length, \"fields, values array length mismatch\");\n\n        // add an id entry to the table's set of ids for the row\n        table.addValueForKey(tableKey, id);\n\n        for (uint i = 0; i < len; i++) {\n\n            // for each row check if the full field + id + table is a subhash\n            require(isNamehashSubOf(fieldKeys[i], idTableKey, fieldIdTableKeys[i]) == true, \"fieldKey not a subhash [field].[id].[table]\");\n\n            elajsStore[fieldIdTableKeys[i]] = bytes32(values[i]);\n        }\n\n    }\n    */\n\n    /*\n    function getAllDataKeys() external view returns (bytes32[] memory) {\n        return database.enumerate();\n    }\n    */\n\n    function checkDataKey(bytes32 key) external view returns (bool) {\n        return database.containsKey(key);\n    }\n\n    /**\n     * @dev all data is public, so no need for security checks, we leave the data type handling to the client\n     */\n    function getRowValue(bytes32 fieldIdTableKey) external view returns (bytes32) {\n\n        if (database.containsKey(fieldIdTableKey)) {\n            return database.getBytes32ForKey(fieldIdTableKey);\n        } else {\n            return bytes32(0);\n        }\n    }\n\n    /*\n    function getRowValueVar(bytes32 fieldIdTableKey) external view returns (bytes memory) {\n\n        if (database.containsKey(fieldIdTableKey)) {\n            return database.getBytesForKey(fieldIdTableKey);\n        } else {\n            return new bytes(0);\n        }\n    }\n    */\n\n    /**\n     * @dev Warning this produces an Error: overflow (operation=\"setValue\", fault=\"overflow\", details=\"Number can only safely store up to 53 bits\")\n     *      if the table doesn't exist\n     */\n    function getTableIds(bytes32 tableKey) external view returns (bytes32[] memory){\n\n        require(tableId.containsKey(tableKey) == true, \"table not created\");\n\n        return tableId.enumerateForKey(tableKey);\n    }\n\n    function getIdExists(bytes32 tableKey, bytes32 id) external view returns (bool) {\n        return tableId.containsValueForKey(tableKey, id);\n    }\n\n    function isNamehashSubOf(bytes32 subKey, bytes32 base, bytes32 target) internal pure returns (bool) {\n\n        bytes memory concat = new bytes(64);\n\n        assembly {\n            mstore(add(concat, 64), subKey)\n            mstore(add(concat, 32), base)\n        }\n\n        bytes32 result = keccak256(concat);\n\n        return result == target;\n    }\n\n    // ************************************* _TABLE FUNCTIONS *************************************\n    function getTableMetadata(bytes32 _tableKey)\n        view\n        public\n        returns (uint256 permission, address delegate)\n    {\n        require(_table[_tableKey] > 0, \"table does not exist\");\n\n        uint256 tableMetadata = uint256(_table[_tableKey]);\n\n        permission = uint256(uint8(tableMetadata));\n        delegate = address(tableMetadata>>8);\n    }\n\n    function setTableMetadata(bytes32 _tableKey, uint8 permission, address delegate) private onlyOwner {\n        uint256 tableMetadata;\n\n        tableMetadata |= permission;\n        tableMetadata |= uint160(delegate)<<8;\n\n        _table[_tableKey] = bytes32(tableMetadata);\n    }\n\n    // ************************************* MISC FUNCTIONS *************************************\n\n    function() external payable {}\n\n    // ************************************* GSN FUNCTIONS *************************************\n\n    /**\n     * As a first layer of defense we employ a max number of checks per day\n     */\n    function acceptRelayedCall(\n        address relay,\n        address from,\n        bytes calldata encodedFunction,\n        uint256 transactionFee,\n        uint256 gasPrice,\n        uint256 gasLimit,\n        uint256 nonce,\n        bytes calldata approvalData,\n        uint256 maxPossibleCharge\n    ) external view returns (uint256, bytes memory) {\n\n        bytes32 curDateHashed = getGsnCounter();\n\n        // check gsnCounter for today and compare to limit\n        uint256 curCounter = gsnCounter[curDateHashed];\n\n        if (curCounter >= gsnMaxCallsPerDay){\n            return _rejectRelayedCall(2);\n        }\n\n\n        return _approveRelayedCall();\n    }\n\n    function setGsnMaxCallsPerDay(uint256 max) external onlyOwner {\n        gsnMaxCallsPerDay = uint40(max);\n    }\n\n    /*\n    event GsnCounterIncrease (\n        address indexed _from,\n        bytes4 indexed curDate\n    );\n    */\n\n    /**\n     * Increase the GSN Counter for today\n     */\n    function increaseGsnCounter() internal {\n\n        bytes32 curDateHashed = getGsnCounter();\n\n        uint256 curCounter = gsnCounter[curDateHashed];\n\n        gsnCounter[curDateHashed] = curCounter + 1;\n\n        // emit GsnCounterIncrease(_msgSender(), bytes4(uint32(curDate)));\n    }\n\n    /*\n     *\n     */\n    function getGsnCounter() internal view returns (bytes32 curDateHashed) {\n\n        uint256 curDate;\n\n        uint16 year = dateTime.getYear(now);\n        uint8 month = dateTime.getMonth(now);\n        uint8 day = dateTime.getDay(now);\n\n        curDate |= year;\n        curDate |= uint256(month)<<16;\n        curDate |= uint256(day)<<24;\n\n        curDateHashed = keccak256(abi.encodePacked(curDate));\n    }\n\n    // We won't do any pre or post processing, so leave _preRelayedCall and _postRelayedCall empty\n    function _preRelayedCall(bytes memory context) internal returns (bytes32) {\n    }\n\n    function _postRelayedCall(bytes memory context, bool, uint256 actualCharge, bytes32) internal {\n    }\n\n    /**\n     * @dev Withdraw a specific amount of the GSNReceipient funds\n     * @param amt Amount of wei to withdraw\n     * @param dest This is the arbitrary withdrawal destination address\n     */\n    function withdraw(uint256 amt, address payable dest) public onlyOwner {\n        IRelayHubELA relayHub = getRelayHub();\n        relayHub.withdraw(amt, dest);\n    }\n\n    /**\n     * @dev Withdraw all the GSNReceipient funds\n     * @param dest This is the arbitrary withdrawal destination address\n     */\n    function withdrawAll(address payable dest) public onlyOwner returns (uint256) {\n        IRelayHubELA relayHub = getRelayHub();\n        uint256 balance = getRelayHub().balanceOf(address(this));\n        relayHub.withdraw(balance, dest);\n        return balance;\n    }\n\n    function getGSNBalance() public view returns (uint256) {\n        return getRelayHub().balanceOf(address(this));\n    }\n\n    function getRelayHub() internal view returns (IRelayHubELA) {\n        return IRelayHubELA(_getRelayHub());\n    }\n}\n";
var sourcePath = "contracts/ELAJSStore.sol";
var sourceMap = "782:22245:2:-;;;1008:42;1147;;;;;;;;;;;;;;;;;;;;782:22245;;;;;;";
var deployedSourceMap = "782:22245:2:-;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;22215:162;;8:9:-1;5:2;;;30:1;27;20:12;5:2;22215:162:2;;;;;;;;;;;;;;;;;;;1538:31;;8:9:-1;5:2;;;30:1;27;20:12;5:2;1538:31:2;;;;;;;;;;;;;;;;;;;;17252:113;;8:9:-1;5:2;;;30:1;27;20:12;5:2;17252:113:2;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;10000:280;;8:9:-1;5:2;;;30:1;27;20:12;5:2;10000:280:2;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;3820:1087;;8:9:-1;5:2;;;30:1;27;20:12;5:2;3820:1087:2;;;;;;;;;;;;;;;;;;;22790:117;;8:9:-1;5:2;;;30:1;27;20:12;5:2;22790:117:2;;;;;;;;;;;;;;;;;;;;2513:106;;8:9:-1;5:2;;;30:1;27;20:12;5:2;2513:106:2;;;;;;;;;;;;;;;;;;;;1434:45;;8:9:-1;5:2;;;30:1;27;20:12;5:2;1434:45:2;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;11701:713;;8:9:-1;5:2;;;30:1;27;20:12;5:2;11701:713:2;;;;;;;;;;;;;;;;;;;17497:260;;8:9:-1;5:2;;;30:1;27;20:12;5:2;17497:260:2;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;1724:137:17;;8:9:-1;5:2;;;30:1;27;20:12;5:2;1724:137:17;;;;;;589:90:8;;8:9:-1;5:2;;;30:1;27;20:12;5:2;589:90:8;;;;;;;;;;;;;;;;;;;;945:210:11;;8:9:-1;5:2;;;30:1;27;20:12;5:2;945:210:11;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;3065:152:2;;8:9:-1;5:2;;;30:1;27;20:12;5:2;3065:152:2;;;;;;20055:655;;8:9:-1;5:2;;;30:1;27;20:12;5:2;20055:655:2;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;937:77:17;;8:9:-1;5:2;;;30:1;27;20:12;5:2;937:77:17;;;;;;;;;;;;;;;;;;;;1288:92;;8:9:-1;5:2;;;30:1;27;20:12;5:2;1288:92:17;;;;;;;;;;;;;;;;;;;;7050:1169:2;;8:9:-1;5:2;;;30:1;27;20:12;5:2;7050:1169:2;;;;;;;;;;;;;;;;;;;5603:186;;8:9:-1;5:2;;;30:1;27;20:12;5:2;5603:186:2;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;793:227:8;;8:9:-1;5:2;;;30:1;27;20:12;5:2;793:227:8;;;;;;;;;;;;;;;;;;;;20716:110:2;;8:9:-1;5:2;;;30:1;27;20:12;5:2;20716:110:2;;;;;;;;;;;;;;;;;;;18254:215;;8:9:-1;5:2;;;30:1;27;20:12;5:2;18254:215:2;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;719:142:17;;8:9:-1;5:2;;;30:1;27;20:12;5:2;719:142:17;;;;;;;;;;;;;;;;;;;969:81:2;;8:9:-1;5:2;;;30:1;27;20:12;5:2;969:81:2;;;;;;;;;;;;;;;;;;;;19080:363;;8:9:-1;5:2;;;30:1;27;20:12;5:2;19080:363:2;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;1412:276:11;;8:9:-1;5:2;;;30:1;27;20:12;5:2;1412:276:11;;;;;;;;;;;;;;;;;;;15609:318:2;;8:9:-1;5:2;;;30:1;27;20:12;5:2;15609:318:2;;;;;;;;;;;;;;;;;;;4946:203;;8:9:-1;5:2;;;30:1;27;20:12;5:2;4946:203:2;;;;;;;;;;;;;;;;;;;18475:145;;8:9:-1;5:2;;;30:1;27;20:12;5:2;18475:145:2;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;2010:107:17;;8:9:-1;5:2;;;30:1;27;20:12;5:2;2010:107:17;;;;;;;;;;;;;;;;;;;22520:264:2;;8:9:-1;5:2;;;30:1;27;20:12;5:2;22520:264:2;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;14005:1325;;8:9:-1;5:2;;;30:1;27;20:12;5:2;14005:1325:2;;;;;;;;;;;;;;;;;;;22215:162;1141:9:17;:7;:9::i;:::-;1133:54;;;;;;;;;;;;;;;;;;;;;;;;22295:21:2;22319:13;:11;:13::i;:::-;22295:37;;22342:8;:17;;;22360:3;22365:4;22342:28;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;8:9:-1;5:2;;;30:1;27;20:12;5:2;22342:28:2;;;;8:9:-1;5:2;;;45:16;42:1;39;24:38;77:16;74:1;67:27;5:2;22342:28:2;;;;1197:1:17;22215:162:2;;:::o;1538:31::-;;;;;;;;;;;;;:::o;17252:113::-;17310:4;17333:25;17354:3;17333:8;:20;;:25;;;;:::i;:::-;17326:32;;17252:113;;;:::o;10000:280::-;10059:16;10077:18;10107:19;10137:37;10163:10;10137:8;:25;;:37;;;;:::i;:::-;10129:46;;;10107:68;;10214:11;10200:27;;10186:41;;10269:2;10256:11;:15;52:12:-1;49:1;45:20;29:14;25:41;7:59;;10256:15:2;10237:35;;10000:280;;;;:::o;3820:1087::-;1141:9:17;:7;:9::i;:::-;1133:54;;;;;;;;;;;;;;;;;;;;;;;;4335:1:2;4315:21;;:6;:16;4322:8;4315:16;;;;;;;;;;;;:21;4307:54;;;;;;;;;;;;;;;;;;;;;;;;4372:16;4399:3;4372:31;;4465:48;4482:8;4492:10;4504:8;4465:16;:48::i;:::-;4524:49;2553:66;4548:13;;4563:9;4524:8;:23;;:49;;;;;:::i;:::-;;4653:24;4668:8;4653:7;:14;;:24;;;;:::i;:::-;;4721:33;;:::i;:::-;4757:99;4786:9;4809:11;4834:12;4757:15;:99::i;:::-;4721:135;;4867:33;4878:8;4888:11;4867:10;:33::i;:::-;;1197:1:17;;3820:1087:2;;;;;:::o;22790:117::-;22836:7;22862:13;:11;:13::i;:::-;:23;;;22894:4;22862:38;;;;;;;;;;;;;;;;;;;;;;;;;;;;8:9:-1;5:2;;;30:1;27;20:12;5:2;22862:38:2;;;;8:9:-1;5:2;;;45:16;42:1;39;24:38;77:16;74:1;67:27;5:2;22862:38:2;;;;;;;101:4:-1;97:9;90:4;84;80:15;76:31;69:5;65:43;126:6;120:4;113:20;0:138;22862:38:2;;;;;;;;;22855:45;;22790:117;:::o;2513:106::-;2553:66;2513:106;;;:::o;1434:45::-;;;;;;;;;;;;;;;;;:::o;11701:713::-;11925:8;11935:5;11942:10;10372:18;10392:16;10412:26;10429:8;10412:16;:26::i;:::-;10371:67;;;;10534:1;10521:10;:14;10513:53;;;;;;;;;;;;;;;;;;;;;;;;10658:1;10645:10;:14;:35;;;;10676:4;10663:17;;:9;:7;:9::i;:::-;:17;;;10645:35;:63;;;;10696:12;:10;:12::i;:::-;10684:24;;:8;:24;;;10645:63;10637:122;;;;;;;;;;;;;;;;;;;;;;;;10905:4;10857:52;;:44;10873:5;10880:8;10890:10;10857:15;:44::i;:::-;:52;;;10849:102;;;;;;;;;;;;;;;;;;;;;;;;11139:1;11125:10;:15;;11121:557;;;11238:19;11260:37;11286:10;11260:8;:25;;:37;;;;:::i;:::-;11238:59;;11311:16;11360:2;11346:11;11338:20;;;:24;52:12:-1;49:1;45:20;29:14;25:41;7:59;;11338:24:2;11311:52;;11461:12;:10;:12::i;:::-;11449:24;;:8;:24;;;11445:222;;;;;;11558:4;11545:17;;:9;:7;:9::i;:::-;:17;;;:45;;;;11578:12;:10;:12::i;:::-;11566:24;;:8;:24;;;11545:45;11537:115;;;;;;;;;;;;;;;;;;;;;;;;11445:222;11121:557;;;12018:4;11973:49;;:41;12001:8;12011:2;11973:7;:27;;:41;;;;;:::i;:::-;:49;;;11965:90;;;;;;;;;;;;;;;;;;;;;;;;12197:4;12139:62;;:54;12155:8;12165:10;12177:15;12139;:54::i;:::-;:62;;;12131:118;;;;;;;;;;;;;;;;;;;;;;;;12289:20;:18;:20::i;:::-;12352:54;12376:15;12401:3;12352:8;:23;;:54;;;;;:::i;:::-;;11701:713;;;;;;;;;;;;:::o;17497:260::-;17566:7;17590:37;17611:15;17590:8;:20;;:37;;;;:::i;:::-;17586:165;;;17650:42;17676:15;17650:8;:25;;:42;;;;:::i;:::-;17643:49;;;;17586:165;17738:1;17730:10;;17723:17;;17497:260;;;;:::o;1724:137:17:-;1141:9;:7;:9::i;:::-;1133:54;;;;;;;;;;;;;;;;;;;;;;;;1822:1;1785:40;;1806:6;;;;;;;;;;;1785:40;;;;;;;;;;;;1852:1;1835:6;;:19;;;;;;;;;;;;;;;;;;1724:137::o;589:90:8:-;632:7;658:14;:12;:14::i;:::-;651:21;;589:90;:::o;945:210:11:-;1011:7;1052:12;:10;:12::i;:::-;1038:26;;:10;:26;;;1030:77;;;;;;;;;;;;;;;;;;;;;;;;1124:24;1140:7;;1124:24;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;30:3:-1;22:6;14;1:33;99:1;93:3;85:6;81:16;74:27;137:4;133:9;126:4;121:3;117:14;113:30;106:37;;169:3;161:6;157:16;147:26;;1124:24:11;;;;;;:15;:24::i;:::-;1117:31;;945:210;;;;:::o;3065:152:2:-;1055:12:16;;;;;;;;;;;:31;;;;1071:15;:13;:15::i;:::-;1055:31;:47;;;;1091:11;;;;;;;;;;;1090:12;1055:47;1047:106;;;;;;;;;;;;;;;;;;;;;;;;1164:19;1187:12;;;;;;;;;;;1186:13;1164:35;;1213:14;1209:96;;;1258:4;1243:12;;:19;;;;;;;;;;;;;;;;;;1290:4;1276:11;;:18;;;;;;;;;;;;;;;;;;1209:96;3116:33:2;3138:10;3116:21;:33::i;:::-;3159:28;:26;:28::i;:::-;3197:13;:11;:13::i;:::-;1331:14:16;1327:65;;;1376:5;1361:12;;:20;;;;;;;;;;;;;;;;;;1327:65;3065:152:2;:::o;20055:655::-;20375:7;20384:12;20409:21;20433:15;:13;:15::i;:::-;20409:39;;20518:18;20539:10;:25;20550:13;20539:25;;;;;;;;;;;;20518:46;;20593:17;;;;;;;;;;;20579:31;;:10;:31;;20575:89;;;20632:21;20651:1;20632:18;:21::i;:::-;20625:28;;;;;;;;20575:89;20682:21;:19;:21::i;:::-;20675:28;;;;;;20055:655;;;;;;;;;;;;;;;:::o;937:77:17:-;975:7;1001:6;;;;;;;;;;;994:13;;937:77;:::o;1288:92::-;1328:4;1367:6;;;;;;;;;;;1351:22;;:12;:10;:12::i;:::-;:22;;;1344:29;;1288:92;:::o;7050:1169:2:-;7274:8;7284:5;7291:10;6038:18;6058:16;6078:26;6095:8;6078:16;:26::i;:::-;6037:67;;;;6200:1;6187:10;:14;6179:58;;;;;;;;;;;;;;;;;;;;;;;;6329:1;6316:10;:14;:35;;;;6347:4;6334:17;;:9;:7;:9::i;:::-;:17;;;6316:35;:63;;;;6367:12;:10;:12::i;:::-;6355:24;;:8;:24;;;6316:63;6308:122;;;;;;;;;;;;;;;;;;;;;;;;6576:4;6528:52;;:44;6544:5;6551:8;6561:10;6528:15;:44::i;:::-;:52;;;6520:102;;;;;;;;;;;;;;;;;;;;;;;;7362:5;7321:46;;:37;7342:15;7321:8;:20;;:37;;;;:::i;:::-;:46;;;7313:82;;;;;;;;;;;;;;;;;;;;;;;;7537:4;7479:62;;:54;7495:8;7505:10;7517:15;7479;:54::i;:::-;:62;;;7471:118;;;;;;;;;;;;;;;;;;;;;;;;7629:20;:18;:20::i;:::-;7773:36;7796:8;7806:2;7773:7;:22;;:36;;;;;:::i;:::-;;7971:5;7935:41;;:32;7956:10;7935:8;:20;;:32;;;;:::i;:::-;:41;;;7931:109;;;7991:38;8004:10;8016:2;8020:8;7991:12;:38::i;:::-;7931:109;8157:54;8181:15;8206:3;8157:8;:23;;:54;;;;;:::i;:::-;;7050:1169;;;;;;;;;;;;:::o;5603:186::-;5658:21;;:::i;:::-;5691:20;5714:30;5738:5;5714:8;:23;;:30;;;;:::i;:::-;5691:53;;5761:21;:7;:19;:21::i;:::-;5754:28;;;5603:186;;;:::o;793:227:8:-;841:13;999:14;;;;;;;;;;;;;;;;;;;;793:227;:::o;20716:110:2:-;1141:9:17;:7;:9::i;:::-;1133:54;;;;;;;;;;;;;;;;;;;;;;;;20815:3:2;20788:17;;:31;;;;;;;;;;;;;;;;;;20716:110;:::o;18254:215::-;18316:16;18385:4;18352:37;;:29;18372:8;18352:7;:19;;:29;;;;:::i;:::-;:37;;;18344:67;;;;;;;;;;;;;;;;;;;;;;;;18429:33;18453:8;18429:7;:23;;:33;;;;:::i;:::-;18422:40;;18254:215;;;:::o;719:142:17:-;1055:12:16;;;;;;;;;;;:31;;;;1071:15;:13;:15::i;:::-;1055:31;:47;;;;1091:11;;;;;;;;;;;1090:12;1055:47;1047:106;;;;;;;;;;;;;;;;;;;;;;;;1164:19;1187:12;;;;;;;;;;;1186:13;1164:35;;1213:14;1209:96;;;1258:4;1243:12;;:19;;;;;;;;;;;;;;;;;;1290:4;1276:11;;:18;;;;;;;;;;;;;;;;;;1209:96;793:6:17;784;;:15;;;;;;;;;;;;;;;;;;847:6;;;;;;;;;;;814:40;;843:1;814:40;;;;;;;;;;;;1331:14:16;1327:65;;;1376:5;1361:12;;:20;;;;;;;;;;;;;;;;;;1327:65;719:142:17;;:::o;969:81:2:-;1008:42;969:81;:::o;19080:363::-;19170:18;19190:16;19250:1;19230:21;;:6;:17;19237:9;19230:17;;;;;;;;;;;;:21;19222:54;;;;;;;;;;;;;;;;;;;;;;;;19287:21;19319:6;:17;19326:9;19319:17;;;;;;;;;;;;19311:26;;;19287:50;;19375:13;19361:29;;19348:42;;19434:1;19419:13;:16;52:12:-1;49:1;45:20;29:14;25:41;7:59;;19419:16:2;19400:36;;19080:363;;;;:::o;1412:276:11:-;1557:12;:10;:12::i;:::-;1543:26;;:10;:26;;;1535:77;;;;;;;;;;;;;;;;;;;;;;;;1622:59;1639:7;;1622:59;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;30:3:-1;22:6;14;1:33;99:1;93:3;85:6;81:16;74:27;137:4;133:9;126:4;121:3;117:14;113:30;106:37;;169:3;161:6;157:16;147:26;;1622:59:11;;;;;;1648:7;1657:12;1671:9;1622:16;:59::i;:::-;1412:276;;;;;:::o;15609:318:2:-;15753:8;15763:10;15775:5;15782:2;12570:4;12525:49;;:41;12553:8;12563:2;12525:7;:27;;:41;;;;;:::i;:::-;:49;;;12517:78;;;;;;;;;;;;;;;;;;;;;;;;12607:18;12627:16;12647:26;12664:8;12647:16;:26::i;:::-;12606:67;;;;12769:1;12756:10;:14;12748:58;;;;;;;;;;;;;;;;;;;;;;;;12898:1;12885:10;:14;:35;;;;12916:4;12903:17;;:9;:7;:9::i;:::-;:17;;;12885:35;:63;;;;12936:12;:10;:12::i;:::-;12924:24;;:8;:24;;;12885:63;12877:122;;;;;;;;;;;;;;;;;;;;;;;;13145:4;13097:52;;:44;13113:5;13120:8;13130:10;13097:15;:44::i;:::-;:52;;;13089:102;;;;;;;;;;;;;;;;;;;;;;;;13379:1;13365:10;:15;;13361:457;;;13400:9;:7;:9::i;:::-;:37;;;;13425:12;:10;:12::i;:::-;13413:24;;:8;:24;;;13400:37;13396:412;;;;;;13586:19;13608:37;13634:10;13608:8;:25;;:37;;;;:::i;:::-;13586:59;;13663:16;13712:2;13698:11;13690:20;;;:24;52:12:-1;49:1;45:20;29:14;25:41;7:59;;13690:24:2;13663:52;;13753:12;:10;:12::i;:::-;13741:24;;:8;:24;;;13733:60;;;;;;;;;;;;;;;;;;;;;;;;13396:412;;;13361:457;15825:20;:18;:20::i;:::-;15881:39;15907:8;15917:2;15881:7;:25;;:39;;;;;:::i;:::-;;15609:318;;;;;;;;;;:::o;4946:203::-;1141:9:17;:7;:9::i;:::-;1133:54;;;;;;;;;;;;;;;;;;;;;;;;5053:52:2;2553:66;5080:13;;5095:9;5053:8;:26;;:52;;;;;:::i;:::-;;5115:27;5133:8;5115:7;:17;;:27;;;;:::i;:::-;;4946:203;;:::o;18475:145::-;18549:4;18572:41;18600:8;18610:2;18572:7;:27;;:41;;;;;:::i;:::-;18565:48;;18475:145;;;;:::o;2010:107:17:-;1141:9;:7;:9::i;:::-;1133:54;;;;;;;;;;;;;;;;;;;;;;;;2082:28;2101:8;2082:18;:28::i;:::-;2010:107;:::o;22520:264:2:-;22589:7;1141:9:17;:7;:9::i;:::-;1133:54;;;;;;;;;;;;;;;;;;;;;;;;22608:21:2;22632:13;:11;:13::i;:::-;22608:37;;22655:15;22673:13;:11;:13::i;:::-;:23;;;22705:4;22673:38;;;;;;;;;;;;;;;;;;;;;;;;;;;;8:9:-1;5:2;;;30:1;27;20:12;5:2;22673:38:2;;;;8:9:-1;5:2;;;45:16;42:1;39;24:38;77:16;74:1;67:27;5:2;22673:38:2;;;;;;;101:4:-1;97:9;90:4;84;80:15;76:31;69:5;65:43;126:6;120:4;113:20;0:138;22673:38:2;;;;;;;;;22655:56;;22721:8;:17;;;22739:7;22748:4;22721:32;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;8:9:-1;5:2;;;30:1;27;20:12;5:2;22721:32:2;;;;8:9:-1;5:2;;;45:16;42:1;39;24:38;77:16;74:1;67:27;5:2;22721:32:2;;;;22770:7;22763:14;;;;22520:264;;;:::o;14005:1325::-;14209:8;14219:10;14231:5;14238:2;12570:4;12525:49;;:41;12553:8;12563:2;12525:7;:27;;:41;;;;;:::i;:::-;:49;;;12517:78;;;;;;;;;;;;;;;;;;;;;;;;12607:18;12627:16;12647:26;12664:8;12647:16;:26::i;:::-;12606:67;;;;12769:1;12756:10;:14;12748:58;;;;;;;;;;;;;;;;;;;;;;;;12898:1;12885:10;:14;:35;;;;12916:4;12903:17;;:9;:7;:9::i;:::-;:17;;;12885:35;:63;;;;12936:12;:10;:12::i;:::-;12924:24;;:8;:24;;;12885:63;12877:122;;;;;;;;;;;;;;;;;;;;;;;;13145:4;13097:52;;:44;13113:5;13120:8;13130:10;13097:15;:44::i;:::-;:52;;;13089:102;;;;;;;;;;;;;;;;;;;;;;;;13379:1;13365:10;:15;;13361:457;;;13400:9;:7;:9::i;:::-;:37;;;;13425:12;:10;:12::i;:::-;13413:24;;:8;:24;;;13400:37;13396:412;;;;;;13586:19;13608:37;13634:10;13608:8;:25;;:37;;;;:::i;:::-;13586:59;;13663:16;13712:2;13698:11;13690:20;;;:24;52:12:-1;49:1;45:20;29:14;25:41;7:59;;13690:24:2;13663:52;;13753:12;:10;:12::i;:::-;13741:24;;:8;:24;;;13733:60;;;;;;;;;;;;;;;;;;;;;;;;13396:412;;;13361:457;14393:4;14335:62;;:54;14351:8;14361:10;14373:15;14335;:54::i;:::-;:62;;;14327:118;;;;;;;;;;;;;;;;;;;;;;;;14485:20;:18;:20::i;:::-;14542:12;14557:35;14576:15;14557:8;:18;;:35;;;;:::i;:::-;14542:50;;14622:4;14611:15;;:7;:15;;;14603:46;;;;;;;;;;;;;;;;;;;;;;;;13828:1;14005:1325;;;;;;;;;;;;:::o;22913:112::-;22959:12;23003:14;:12;:14::i;:::-;22983:35;;22913:112;:::o;5682:394:26:-;5806:4;5845:42;5882:4;5845:10;:24;;:36;;:42;;;;:::i;:::-;:103;;;;5903:45;5943:4;5903:10;:27;;:39;;:45;;;;:::i;:::-;5845:103;:162;;;;5964:43;6002:4;5964:10;:25;;:37;;:43;;;;:::i;:::-;5845:162;:224;;;;6023:46;6064:4;6023:10;:28;;:40;;:46;;;;:::i;:::-;5845:224;5826:243;;5682:394;;;;:::o;9510:203::-;9636:7;9662:44;9702:3;9662:10;:24;;:39;;:44;;;;:::i;:::-;9655:51;;9510:203;;;;:::o;19449:275:2:-;1141:9:17;:7;:9::i;:::-;1133:54;;;;;;;;;;;;;;;;;;;;;;;;19558:21:2;19607:10;19590:27;;;;;;19663:1;19652:8;19644:20;;;;;;19627:37;;;;;;19703:13;19695:22;;19675:6;:17;19682:9;19675:17;;;;;;;;;;;:42;;;;1197:1:17;19449:275:2;;;:::o;20565:632:26:-;20709:4;20747:42;20784:4;20747:10;:24;;:36;;:42;;;;:::i;:::-;20746:43;20725:122;;;;;;;;;;;;;;;;;;;;;;;;20879:45;20919:4;20879:10;:27;;:39;;:45;;;;:::i;:::-;20878:46;20857:125;;;;;;;;;;;;;;;;;;;;;;;;21014:46;21055:4;21014:10;:28;;:40;;:46;;;;:::i;:::-;21013:47;20992:126;;;;;;;;;;;;;;;;;;;;;;;;21136:54;21177:4;21183:6;21136:10;:25;;:40;;:54;;;;;:::i;:::-;21129:61;;20565:632;;;;;:::o;818:168:21:-;925:4;952:27;975:3;952:13;:18;;:22;;:27;;;;:::i;:::-;945:34;;818:168;;;;:::o;1327:396:31:-;1472:12;;:::i;:::-;1526;:19;1504:11;:18;:41;1496:70;;;;;;;;;;;;;;;;;;;;;;;;1576:18;;:::i;:::-;1617:5;1604;:10;;:18;;;;;1648:46;1669:11;1681:12;1648:20;:46::i;:::-;1632:5;:13;;:62;;;;1711:5;1704:12;;;1327:396;;;;;:::o;5294:283:2:-;5385:4;5401:20;5424;:11;:18;:20::i;:::-;5401:43;;5528:42;5552:8;5562:7;5528:8;:23;;:42;;;;;:::i;:::-;5521:49;;;5294:283;;;;:::o;2181:207:7:-;2226:7;2263:14;:12;:14::i;:::-;2249:28;;:10;:28;;;;2245:137;;;2300:10;2293:17;;;;2245:137;2348:23;:21;:23::i;:::-;2341:30;;2181:207;;:::o;18626:348:2:-;18720:4;18737:19;18769:2;18759:13;;;;;;;;;;;;;;;;;;;;;;;;;29:1:-1;21:6;17:14;116:4;104:10;96:6;87:34;147:4;139:6;135:17;125:27;;0:156;18759:13:2;;;;18737:35;;18830:6;18825:2;18817:6;18813:15;18806:31;18874:4;18869:2;18861:6;18857:15;18850:29;18899:14;18926:6;18916:17;;;;;;18899:34;;18961:6;18951;:16;18944:23;;;;18626:348;;;;;:::o;3540:327:21:-;3694:4;3714:31;3726:13;3741:3;3714:11;:31::i;:::-;3710:151;;;3768:39;3801:5;3768:13;:18;;:23;3787:3;3768:23;;;;;;;;;;;:32;;:39;;;;:::i;:::-;3761:46;;;;3710:151;3845:5;3838:12;;3540:327;;;;;;:::o;21005:282:2:-;21055:21;21079:15;:13;:15::i;:::-;21055:39;;21105:18;21126:10;:25;21137:13;21126:25;;;;;;;;;;;;21105:46;;21203:1;21190:10;:14;21162:10;:25;21173:13;21162:25;;;;;;;;;;;:42;;;;21005:282;;:::o;16647:632:26:-;16791:4;16829:45;16869:4;16829:10;:27;;:39;;:45;;;;:::i;:::-;16828:46;16807:125;;;;;;;;;;;;;;;;;;;;;;;;16964:43;17002:4;16964:10;:25;;:37;;:43;;;;:::i;:::-;16963:44;16942:123;;;;;;;;;;;;;;;;;;;;;;;;17097:46;17138:4;17097:10;:28;;:40;;:46;;;;:::i;:::-;17096:47;17075:126;;;;;;;;;;;;;;;;;;;;;;;;17219:53;17259:4;17265:6;17219:10;:24;;:39;;:53;;;;;:::i;:::-;17212:60;;16647:632;;;;;:::o;1110:248:7:-;1157:16;1185:12;754:66;1200:30;;1185:45;;1337:4;1331:11;1319:23;;1305:47;;:::o;21823:81:2:-;21888:7;21823:81;;;:::o;1488:536:16:-;1535:4;1900:12;1923:4;1900:28;;1938:10;1987:4;1975:17;1969:23;;2016:1;2010:2;:7;2003:14;;;;1488:536;:::o;499:84:8:-;1055:12:16;;;;;;;;;;;:31;;;;1071:15;:13;:15::i;:::-;1055:31;:47;;;;1091:11;;;;;;;;;;;1090:12;1055:47;1047:106;;;;;;;;;;;;;;;;;;;;;;;;1164:19;1187:12;;;;;;;;;;;1186:13;1164:35;;1213:14;1209:96;;;1258:4;1243:12;;:19;;;;;;;;;;;;;;;;;;1290:4;1276:11;;:18;;;;;;;;;;;;;;;;;;1209:96;550:26:8;:24;:26::i;:::-;1331:14:16;1327:65;;;1376:5;1361:12;;:20;;;;;;;;;;;;;;;;;;1327:65;499:84:8;:::o;3223:279:2:-;3285:4;3265:17;;:24;;;;;;;;;;;;;;;;;;3409:86;2553:66;3425:13;;3440:54;3409:8;:15;;:86;;;;;:::i;:::-;;3223:279::o;21315:403::-;21363:21;21397:15;21423:11;21437:8;;;;;;;;;;;:16;;;21454:3;21437:21;;;;;;;;;;;;;;;;;;;;;;;;;;;;8:9:-1;5:2;;;30:1;27;20:12;5:2;21437:21:2;;;;8:9:-1;5:2;;;45:16;42:1;39;24:38;77:16;74:1;67:27;5:2;21437:21:2;;;;;;;101:4:-1;97:9;90:4;84;80:15;76:31;69:5;65:43;126:6;120:4;113:20;0:138;21437:21:2;;;;;;;;;21423:35;;21468:11;21482:8;;;;;;;;;;;:17;;;21500:3;21482:22;;;;;;;;;;;;;;;;;;;;;;;;;;;;8:9:-1;5:2;;;30:1;27;20:12;5:2;21482:22:2;;;;8:9:-1;5:2;;;45:16;42:1;39;24:38;77:16;74:1;67:27;5:2;21482:22:2;;;;;;;101:4:-1;97:9;90:4;84;80:15;76:31;69:5;65:43;126:6;120:4;113:20;0:138;21482:22:2;;;;;;;;;21468:36;;21514:9;21526:8;;;;;;;;;;;:15;;;21542:3;21526:20;;;;;;;;;;;;;;;;;;;;;;;;;;;;8:9:-1;5:2;;;30:1;27;20:12;5:2;21526:20:2;;;;8:9:-1;5:2;;;45:16;42:1;39;24:38;77:16;74:1;67:27;5:2;21526:20:2;;;;;;;101:4:-1;97:9;90:4;84;80:15;76:31;69:5;65:43;126:6;120:4;113:20;0:138;21526:20:2;;;;;;;;;21514:32;;21568:4;21557:15;;;;;;21609:2;21601:5;21593:14;;:18;;;;21582:29;;;;21646:2;21640:3;21632:12;;:16;;;;21621:27;;;;21702:7;21685:25;;;;;;;;;;;;;;;49:4:-1;39:7;30;26:21;22:32;13:7;6:49;21685:25:2;;;21675:36;;;;;;21659:52;;21315:403;;;;;:::o;2441:156:11:-;2511:7;2520:12;2576:9;427:2;2552:33;2544:46;;;;;;;;;;;;;;;;;2441:156;;;:::o;1869:124::-;1923:7;1932:12;1963:23;;;;;;;;;;;;;;:19;:23::i;:::-;1956:30;;;;1869:124;;:::o;2339:312:21:-;2483:4;2503:31;2515:13;2530:3;2503:11;:31::i;:::-;2499:146;;;2557:34;2585:5;2557:13;:18;;:23;2576:3;2557:23;;;;;;;;;;;:27;;:34;;;;:::i;:::-;2550:41;;;;2499:146;2629:5;2622:12;;2339:312;;;;;;:::o;9183:683:2:-;9319:5;9283:41;;:32;9304:10;9283:8;:20;;:32;;;;:::i;:::-;:41;;;9275:75;;;;;;;;;;;;;;;;;;;;;;;;9361:19;9391:11;9405:8;;;;;;;;;;;:16;;;9422:3;9405:21;;;;;;;;;;;;;;;;;;;;;;;;;;;;8:9:-1;5:2;;;30:1;27;20:12;5:2;9405:21:2;;;;8:9:-1;5:2;;;45:16;42:1;39;24:38;77:16;74:1;67:27;5:2;9405:21:2;;;;;;;101:4:-1;97:9;90:4;84;80:15;76:31;69:5;65:43;126:6;120:4;113:20;0:138;9405:21:2;;;;;;;;;9391:35;;9436:11;9450:8;;;;;;;;;;;:17;;;9468:3;9450:22;;;;;;;;;;;;;;;;;;;;;;;;;;;;8:9:-1;5:2;;;30:1;27;20:12;5:2;9450:22:2;;;;8:9:-1;5:2;;;45:16;42:1;39;24:38;77:16;74:1;67:27;5:2;9450:22:2;;;;;;;101:4:-1;97:9;90:4;84;80:15;76:31;69:5;65:43;126:6;120:4;113:20;0:138;9450:22:2;;;;;;;;;9436:36;;9482:9;9494:8;;;;;;;;;;;:15;;;9510:3;9494:20;;;;;;;;;;;;;;;;;;;;;;;;;;;;8:9:-1;5:2;;;30:1;27;20:12;5:2;9494:20:2;;;;8:9:-1;5:2;;;45:16;42:1;39;24:38;77:16;74:1;67:27;5:2;9494:20:2;;;;;;;101:4:-1;97:9;90:4;84;80:15;76:31;69:5;65:43;126:6;120:4;113:20;0:138;9494:20:2;;;;;;;;;9482:32;;9540:4;9525:19;;;;;;9585:2;9577:5;9569:14;;:18;;;;9554:33;;;;9626:2;9620:3;9612:12;;:16;;;;9597:31;;;;9639:18;9674:11;9660:27;;9639:48;;9736:2;9721:12;:10;:12::i;:::-;9713:21;;:25;;;;9698:40;;;;9749:57;9773:10;9793:11;9785:20;;9749:8;:23;;:57;;;;;:::i;:::-;;9846:12;:10;:12::i;:::-;9822:37;;9836:8;9832:2;9822:37;;;;;;;;;;9183:683;;;;;;;;:::o;11579:209:26:-;11703:12;11734:47;11777:3;11734:10;:27;;:42;;:47;;;;:::i;:::-;11727:54;;11579:209;;;;:::o;2286:403:31:-;2375:12;;:::i;:::-;2403:14;2420:6;:13;2403:30;;2443:18;;:::i;:::-;2484:24;2501:6;2484;:16;;:24;;;;:::i;:::-;2471:5;:10;;:37;;;;;2528:2;2518:12;;;;2566:31;2590:6;2566;:23;;:31;;;;:::i;:::-;2540:57;;;2541:5;:13;;2540:57;;;;;;;;2626:1;2616:6;:11;2608:52;;;;;;;;;;;;;;;;;;;;;;;;2677:5;2670:12;;;;2286:403;;;:::o;992:185:21:-;1115:4;1138:32;1166:3;1138:13;:18;;:27;;:32;;;;:::i;:::-;1131:39;;992:185;;;;:::o;4160:319::-;4287:16;4319:31;4331:13;4346:3;4319:11;:31::i;:::-;4315:158;;;4373:35;:13;:18;;:23;4392:3;4373:23;;;;;;;;;;;:33;:35::i;:::-;4366:42;;;;4315:158;4460:1;4446:16;;;;;;;;;;;;;;;;;;;;;;29:2:-1;21:6;17:15;117:4;105:10;97:6;88:34;148:4;140:6;136:17;126:27;;0:157;4446:16:21;;;;4439:23;;4160:319;;;;;:::o;21910:101:2:-;;;;;:::o;3131:318:21:-;3278:4;3298:31;3310:13;3325:3;3298:11;:31::i;:::-;3294:149;;;3352:37;3383:5;3352:13;:18;;:23;3371:3;3352:23;;;;;;;;;;;:30;;:37;;;;:::i;:::-;3345:44;;;;3294:149;3427:5;3420:12;;3131:318;;;;;;:::o;26876:234:26:-;27023:4;27046:57;27090:4;27096:6;27046:10;:25;;:43;;:57;;;;;:::i;:::-;27039:64;;26876:234;;;;;:::o;2657:324:21:-;2767:4;2791:31;2803:13;2818:3;2791:11;:31::i;:::-;2787:188;;;2891:30;2917:3;2891:13;:18;;:25;;:30;;;;:::i;:::-;2884:37;;;;2787:188;2959:5;2952:12;;2657:324;;;;;:::o;2218:225:17:-;2311:1;2291:22;;:8;:22;;;;2283:73;;;;;;;;;;;;;;;;;;;;;;;;2400:8;2371:38;;2392:6;;;;;;;;;;;2371:38;;;;;;;;;;;;2428:8;2419:6;;:17;;;;;;;;;;;;;;;;;;2218:225;:::o;26241:371:26:-;26350:4;26389:40;26424:4;26389:10;:24;;:34;;:40;;;;:::i;:::-;:99;;;;26445:43;26483:4;26445:10;:27;;:37;;:43;;;;:::i;:::-;26389:99;:156;;;;26504:41;26540:4;26504:10;:25;;:35;;:41;;;;:::i;:::-;26389:156;:216;;;;26561:44;26600:4;26561:10;:28;;:38;;:44;;;;:::i;:::-;26389:216;26370:235;;26241:371;;;;:::o;897:190:20:-;1021:4;1044:36;1076:3;1044:17;:22;;:31;;:36;;;;:::i;:::-;1037:43;;897:190;;;;:::o;803::23:-;925:4;952:34;982:3;952:15;:20;;:29;;:34;;;;:::i;:::-;945:41;;803:190;;;;:::o;1212:189:24:-;1335:4;1362:32;1390:3;1362:13;:18;;:27;;:32;;;;:::i;:::-;1355:39;;1212:189;;;;:::o;3034:265:20:-;3161:7;3188:35;3200:17;3219:3;3188:11;:35::i;:::-;3180:67;;;;;;;;;;;;;;;;;;;;;;;;3265:17;:22;;:27;3288:3;3265:27;;;;;;;;;;;;3258:34;;3034:265;;;;:::o;1036:273:22:-;1122:4;1147:20;1156:3;1161:5;1147:8;:20::i;:::-;1146:21;1142:161;;;1202:3;:10;;1218:5;1202:22;;39:1:-1;33:3;27:10;23:18;57:10;52:3;45:23;79:10;72:17;;0:93;1202:22:22;;;;;;;;;;;;;;;;;;;;;1183:3;:9;;:16;1193:5;1183:16;;;;;;;;;;;:41;;;;1245:4;1238:11;;;;1142:161;1287:5;1280:12;;1036:273;;;;;:::o;1083:535:30:-;1209:15;1266:12;:19;1244:11;:18;:41;1236:70;;;;;;;;;;;;;;;;;;;;;;;;1317:23;1356:11;:18;1343:32;;;;;;;;;;;;;;;;;;;;;;;;;:::i;:::-;;;;;;;;;;;;;;;;;1317:58;;1390:9;1402:1;1390:13;;1385:202;1409:11;:18;1405:1;:22;1385:202;;;1448:17;;:::i;:::-;1490:11;1502:1;1490:14;;;;;;;;;;;;;;;;;;1479:3;:8;;:25;;;;;1531:12;1544:1;1531:15;;;;;;;;;;;;;;;;;;1518:3;:10;;:28;;;;;1573:3;1560:7;1568:1;1560:10;;;;;;;;;;;;;;;;;:16;;;;1385:202;1429:3;;;;;;;1385:202;;;;1604:7;1597:14;;;1083:535;;;;:::o;1780:424:31:-;1839:12;1863:14;1880:11;1885:5;1880:4;:11::i;:::-;1863:28;;1901:17;1931:6;1921:17;;;;;;;;;;;;;;;;;;;;;;;;;29:1:-1;21:6;17:14;116:4;104:10;96:6;87:34;147:4;139:6;135:17;125:27;;0:156;1921:17:31;;;;1901:37;;1963:38;1988:6;1996:4;1963:5;:10;;;:24;;:38;;;;;:::i;:::-;2054:2;2044:12;;;;2075:38;2100:6;2108:4;2075:5;:13;;;:24;;:38;;;;;:::i;:::-;2066:47;;2142:1;2132:6;:11;2124:52;;;;;;;;;;;;;;;;;;;;;;;;2193:4;2186:11;;;;1780:424;;;:::o;19584:637:26:-;19733:4;19771:42;19808:4;19771:10;:24;;:36;;:42;;;;:::i;:::-;19770:43;19749:122;;;;;;;;;;;;;;;;;;;;;;;;19903:43;19941:4;19903:10;:25;;:37;;:43;;;;:::i;:::-;19902:44;19881:123;;;;;;;;;;;;;;;;;;;;;;;;20036:46;20077:4;20036:10;:28;;:40;;:46;;;;:::i;:::-;20035:47;20014:126;;;;;;;;;;;;;;;;;;;;;;;;20158:56;20201:4;20207:6;20158:10;:27;;:42;;:56;;;;;:::i;:::-;20151:63;;19584:637;;;;;:::o;2606:1238:7:-;2661:14;3460:18;3481:8;;3460:29;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;30:3:-1;22:6;14;1:33;99:1;93:3;85:6;81:16;74:27;137:4;133:9;126:4;121:3;117:14;113:30;106:37;;169:3;161:6;157:16;147:26;;3460:29:7;;;;;;;;3499:13;3515:8;;:15;;3499:31;;3762:42;3753:5;3746;3742:17;3736:24;3732:73;3722:83;;3831:6;3824:13;;;;2606:1238;:::o;2540:159:22:-;2644:4;2691:1;2671:3;:9;;:16;2681:5;2671:16;;;;;;;;;;;;:21;;2664:28;;2540:159;;;;:::o;2284:251:20:-;2429:4;2475:5;2445:17;:22;;:27;2468:3;2445:27;;;;;;;;;;;:35;;;;2497:31;2524:3;2497:17;:22;;:26;;:31;;;;:::i;:::-;2490:38;;2284:251;;;;;:::o;913:191:7:-;1055:12:16;;;;;;;;;;;:31;;;;1071:15;:13;:15::i;:::-;1055:31;:47;;;;1091:11;;;;;;;;;;;1090:12;1055:47;1047:106;;;;;;;;;;;;;;;;;;;;;;;;1164:19;1187:12;;;;;;;;;;;1186:13;1164:35;;1213:14;1209:96;;;1258:4;1243:12;;:19;;;;;;;;;;;;;;;;;;1290:4;1276:11;;:18;;;;;;;;;;;;;;;;;;1209:96;964:60:7;981:42;964:16;:60::i;:::-;1331:14:16;1327:65;;;1376:5;1361:12;;:20;;;;;;;;;;;;;;;;;;1327:65;913:191:7;:::o;24588:1438:26:-;24730:4;24769:1;24760:5;24754:12;;;;;;;;:16;;;24746:48;;;;;;;;;;;;;;;;;;;;;;;;24826:42;24863:4;24826:10;:24;;:36;;:42;;;;:::i;:::-;24825:43;24804:122;;;;;;;;;;;;;;;;;;;;;;;;24958:45;24998:4;24958:10;:27;;:39;;:45;;;;:::i;:::-;24957:46;24936:125;;;;;;;;;;;;;;;;;;;;;;;;25093:43;25131:4;25093:10;:25;;:37;;:43;;;;:::i;:::-;25092:44;25071:123;;;;;;;;;;;;;;;;;;;;;;;;25226:46;25267:4;25226:10;:28;;:40;;:46;;;;:::i;:::-;25225:47;25204:126;;;;;;;;;;;;;;;;;;;;;;;;25378:5;25345:38;;;;;;;;:29;:38;;;;;;;;;25341:114;;;25406:38;25439:4;25406:10;:25;;:32;;:38;;;;:::i;:::-;25399:45;;;;25341:114;25504:5;25468:41;;;;;;;;:32;:41;;;;;;;;;25464:120;;;25532:41;25568:4;25532:10;:28;;:35;;:41;;;;:::i;:::-;25525:48;;;;25464:120;25629:5;25597:37;;;;;;;;:28;:37;;;;;;;;;25593:262;;;25673:171;25734:4;25760:66;25673:171;;:10;:24;;:39;;:171;;;;;:::i;:::-;25650:194;;;;25593:262;25903:5;25868:40;;;;;;;;:31;:40;;;;;;;;;25864:156;;;25947:62;25990:4;26006:1;25996:12;;;;;;;;;;;;;;;;;;;;;;;;;29:1:-1;21:6;17:14;116:4;104:10;96:6;87:34;147:4;139:6;135:17;125:27;;0:156;25996:12:26;;;;25947:10;:27;;:42;;:62;;;;;:::i;:::-;25924:85;;;;25864:156;24588:1438;;;;;;:::o;2157:153:11:-;2231:7;2240:12;371:1;2295:7;2264:39;;;;2157:153;;;:::o;2895:262:23:-;3018:12;3050:33;3062:15;3079:3;3050:11;:33::i;:::-;3042:65;;;;;;;;;;;;;;;;;;;;;;;;3125:15;:20;;:25;3146:3;3125:25;;;;;;;;;;;3118:32;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;2895:262;;;;:::o;4371:349:27:-;4474:15;4557:6;4549;4545:19;4539:26;4528:37;;4514:200;;;;:::o;5339:641:30:-;5430:15;5447:7;5466:14;5483:11;5466:28;;5504:16;5523:24;5540:6;5523;:16;;:24;;;;:::i;:::-;5504:43;;5567:2;5557:12;;;;5580:11;377:2;5594:8;:15;;;;;;;;5580:29;;5619:22;5657:3;5644:17;;;;;;;;;;;;;;;;;;;;;;;;;:::i;:::-;;;;;;;;;;;;;;;;;5619:42;;5676:9;5688:1;5676:13;;5671:269;5695:3;5691:1;:7;5671:269;;;5719:20;;:::i;:::-;5767:24;5784:6;5767;:16;;:24;;;;:::i;:::-;5753:6;:11;;:38;;;;;5815:2;5805:12;;;;5847:24;5864:6;5847;:16;;:24;;;;:::i;:::-;5831:6;:13;;:40;;;;;5895:2;5885:12;;;;5923:6;5911;5918:1;5911:9;;;;;;;;;;;;;;;;;:18;;;;5671:269;5700:3;;;;;;;5671:269;;;;5958:6;5966;5950:23;;;;;;;;5339:641;;;;;:::o;3052:313:22:-;3142:16;3174:23;3214:3;:10;;:17;;;;3200:32;;;;;;;;;;;;;;;;;;;;;;29:2:-1;21:6;17:15;117:4;105:10;97:6;88:34;148:4;140:6;136:17;126:27;;0:157;3200:32:22;;;;3174:58;;3247:9;3242:94;3262:3;:10;;:17;;;;3258:1;:21;3242:94;;;3312:3;:10;;3323:1;3312:13;;;;;;;;;;;;;;;;;;3300:6;3307:1;3300:9;;;;;;;;;;;;;;;;;:25;;;;;3281:3;;;;;;;3242:94;;;;3352:6;3345:13;;;3052:313;;;:::o;1439:1020::-;1528:4;1552:20;1561:3;1566:5;1552:8;:20::i;:::-;1548:905;;;1588:21;1631:1;1612:3;:9;;:16;1622:5;1612:16;;;;;;;;;;;;:20;1588:44;;1646:17;1686:1;1666:3;:10;;:17;;;;:21;1646:41;;1824:13;1811:9;:26;;1807:382;;;1857:17;1877:3;:10;;1888:9;1877:21;;;;;;;;;;;;;;;;;;1857:41;;2024:9;1996:3;:10;;2007:13;1996:25;;;;;;;;;;;;;;;;;:37;;;;2146:1;2130:13;:17;2107:3;:9;;:20;2117:9;2107:20;;;;;;;;;;;:40;;;;1807:382;;2270:3;:9;;:16;2280:5;2270:16;;;;;;;;;;;2263:23;;;2357:3;:10;;:16;;;;;;;;;;;;;;;;;;;;;;;;;;2395:4;2388:11;;;;;;1548:905;2437:5;2430:12;;1439:1020;;;;;:::o;2693:335:20:-;2804:4;2828:35;2840:17;2859:3;2828:11;:35::i;:::-;2824:198;;;2886:17;:22;;:27;2909:3;2886:27;;;;;;;;;;;2879:34;;;2934;2964:3;2934:17;:22;;:29;;:34;;;;:::i;:::-;2927:41;;;;2824:198;3006:5;2999:12;;2693:335;;;;;:::o;2564:325:23:-;2671:4;2695:33;2707:15;2724:3;2695:11;:33::i;:::-;2691:192;;;2751:15;:20;;:25;2772:3;2751:25;;;;;;;;;;;;2744:32;;;;:::i;:::-;2797;2825:3;2797:15;:20;;:27;;:32;;;;:::i;:::-;2790:39;;;;2691:192;2867:5;2860:12;;2564:325;;;;;:::o;2878:322:24:-;2986:4;3010:31;3022:13;3037:3;3010:11;:31::i;:::-;3006:188;;;3110:30;3136:3;3110:13;:18;;:25;;:30;;;;:::i;:::-;3103:37;;;;3006:188;3178:5;3171:12;;2878:322;;;;;:::o;666:166:31:-;738:7;776:21;:6;:14;;;:19;:21::i;:::-;771:2;532;764:9;:33;757:40;;666:166;;;:::o;686:174:29:-;837:6;828;819:7;815:20;808:36;794:60;;;:::o;3133:509:30:-;3241:7;3260:14;3277:11;3260:28;;3321:35;3343:6;3351:4;3321:13;3326:7;3321:4;:13::i;:::-;:21;;:35;;;;;:::i;:::-;3376:2;3366:12;;;;3393:9;3405:1;3393:13;;3388:224;3412:7;:14;3408:1;:18;3388:224;;;3447:43;3477:6;3485:4;3447:7;3455:1;3447:10;;;;;;;;;;;;;;;;;;:15;;;:29;;:43;;;;;:::i;:::-;3514:2;3504:12;;;;3530:45;3562:6;3570:4;3530:7;3538:1;3530:10;;;;;;;;;;;;;;;;;;:17;;;:31;;:45;;;;;:::i;:::-;3599:2;3589:12;;;;3428:3;;;;;;;3388:224;;;;3629:6;3622:13;;;3133:509;;;;;:::o;2162:248:23:-;2308:4;2352:5;2324:15;:20;;:25;2345:3;2324:25;;;;;;;;;;;:33;;;;;;;;;;;;:::i;:::-;;2374:29;2399:3;2374:15;:20;;:24;;:29;;;;:::i;:::-;2367:36;;2162:248;;;;;:::o;1364:541:7:-;1430:23;1456:14;:12;:14::i;:::-;1430:40;;1511:1;1488:25;;:11;:25;;;;1480:82;;;;;;;;;;;;;;;;;;;;;;;;1595:15;1580:30;;:11;:30;;;;1572:86;;;;;;;;;;;;;;;;;;;;;;;;1707:11;1674:45;;1690:15;1674:45;;;;;;;;;;;;1730:12;754:66;1745:30;;1730:45;;1877:11;1871:4;1864:25;1850:49;;;:::o;1040:166:24:-;1145:4;1172:27;1195:3;1172:13;:18;;:22;;:27;;;;:::i;:::-;1165:34;;1040:166;;;;:::o;18218:210:27:-;18321:15;18404:6;18396;18392:19;18386:26;18375:37;;18361:61;;;;:::o;511:130:30:-;587:7;377:2;613:7;:14;:21;606:28;;511:130;;;:::o;2013:165:29:-;2155:6;2146;2137:7;2133:20;2126:36;2112:60;;;:::o;782:22245:2:-;;;;;;;;;;;;;;;;;;;;;;;:::o;:::-;;;;;;;;;;;;;;;;;;;;;;;;;;:::o;:::-;;;;;;;;;;;;;;;;;;;;;;;;;;:::o;:::-;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;:::i;:::-;;;:::o;:::-;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;:::i;:::-;;;:::o;:::-;;;;;;;;;;;;;;;;;;;;;;;;;;;:::o;5:118:-1:-;;72:46;110:6;97:20;72:46;;;63:55;;57:66;;;;;130:134;;205:54;251:6;238:20;205:54;;;196:63;;190:74;;;;;289:707;;406:3;399:4;391:6;387:17;383:27;376:35;373:2;;;424:1;421;414:12;373:2;461:6;448:20;483:80;498:64;555:6;498:64;;;483:80;;;474:89;;580:5;605:6;598:5;591:21;635:4;627:6;623:17;613:27;;657:4;652:3;648:14;641:21;;710:6;757:3;749:4;741:6;737:17;732:3;728:27;725:36;722:2;;;774:1;771;764:12;722:2;799:1;784:206;809:6;806:1;803:13;784:206;;;867:3;889:37;922:3;910:10;889:37;;;884:3;877:50;950:4;945:3;941:14;934:21;;978:4;973:3;969:14;962:21;;841:149;831:1;828;824:9;819:14;;784:206;;;788:14;366:630;;;;;;;;1004:112;;1068:43;1103:6;1090:20;1068:43;;;1059:52;;1053:63;;;;;1123:118;;1190:46;1228:6;1215:20;1190:46;;;1181:55;;1175:66;;;;;1262:335;;;1376:3;1369:4;1361:6;1357:17;1353:27;1346:35;1343:2;;;1394:1;1391;1384:12;1343:2;1427:6;1414:20;1404:30;;1454:18;1446:6;1443:30;1440:2;;;1486:1;1483;1476:12;1440:2;1520:4;1512:6;1508:17;1496:29;;1570:3;1563;1555:6;1551:16;1541:8;1537:31;1534:40;1531:2;;;1587:1;1584;1577:12;1531:2;1336:261;;;;;;1605:120;;1682:38;1712:6;1706:13;1682:38;;;1673:47;;1667:58;;;;;1732:118;;1799:46;1837:6;1824:20;1799:46;;;1790:55;;1784:66;;;;;1857:122;;1935:39;1966:6;1960:13;1935:39;;;1926:48;;1920:59;;;;;1986:114;;2051:44;2087:6;2074:20;2051:44;;;2042:53;;2036:64;;;;;2107:118;;2183:37;2212:6;2206:13;2183:37;;;2174:46;;2168:57;;;;;2232:241;;2336:2;2324:9;2315:7;2311:23;2307:32;2304:2;;;2352:1;2349;2342:12;2304:2;2387:1;2404:53;2449:7;2440:6;2429:9;2425:22;2404:53;;;2394:63;;2366:97;2298:175;;;;;2480:257;;2592:2;2580:9;2571:7;2567:23;2563:32;2560:2;;;2608:1;2605;2598:12;2560:2;2643:1;2660:61;2713:7;2704:6;2693:9;2689:22;2660:61;;;2650:71;;2622:105;2554:183;;;;;2744:1497;;;;;;;;;;;;3023:3;3011:9;3002:7;2998:23;2994:33;2991:2;;;3040:1;3037;3030:12;2991:2;3075:1;3092:53;3137:7;3128:6;3117:9;3113:22;3092:53;;;3082:63;;3054:97;3182:2;3200:53;3245:7;3236:6;3225:9;3221:22;3200:53;;;3190:63;;3161:98;3318:2;3307:9;3303:18;3290:32;3342:18;3334:6;3331:30;3328:2;;;3374:1;3371;3364:12;3328:2;3402:64;3458:7;3449:6;3438:9;3434:22;3402:64;;;3384:82;;;;3269:203;3503:2;3521:53;3566:7;3557:6;3546:9;3542:22;3521:53;;;3511:63;;3482:98;3611:3;3630:53;3675:7;3666:6;3655:9;3651:22;3630:53;;;3620:63;;3590:99;3720:3;3739:53;3784:7;3775:6;3764:9;3760:22;3739:53;;;3729:63;;3699:99;3829:3;3848:53;3893:7;3884:6;3873:9;3869:22;3848:53;;;3838:63;;3808:99;3966:3;3955:9;3951:19;3938:33;3991:18;3983:6;3980:30;3977:2;;;4023:1;4020;4013:12;3977:2;4051:64;4107:7;4098:6;4087:9;4083:22;4051:64;;;4033:82;;;;3917:204;4152:3;4172:53;4217:7;4208:6;4197:9;4193:22;4172:53;;;4161:64;;4131:100;2985:1256;;;;;;;;;;;;;;;4248:241;;4352:2;4340:9;4331:7;4327:23;4323:32;4320:2;;;4368:1;4365;4358:12;4320:2;4403:1;4420:53;4465:7;4456:6;4445:9;4441:22;4420:53;;;4410:63;;4382:97;4314:175;;;;;4496:366;;;4617:2;4605:9;4596:7;4592:23;4588:32;4585:2;;;4633:1;4630;4623:12;4585:2;4668:1;4685:53;4730:7;4721:6;4710:9;4706:22;4685:53;;;4675:63;;4647:97;4775:2;4793:53;4838:7;4829:6;4818:9;4814:22;4793:53;;;4783:63;;4754:98;4579:283;;;;;;4869:617;;;;;5024:3;5012:9;5003:7;4999:23;4995:33;4992:2;;;5041:1;5038;5031:12;4992:2;5076:1;5093:53;5138:7;5129:6;5118:9;5114:22;5093:53;;;5083:63;;5055:97;5183:2;5201:53;5246:7;5237:6;5226:9;5222:22;5201:53;;;5191:63;;5162:98;5291:2;5309:53;5354:7;5345:6;5334:9;5330:22;5309:53;;;5299:63;;5270:98;5399:2;5417:53;5462:7;5453:6;5442:9;5438:22;5417:53;;;5407:63;;5378:98;4986:500;;;;;;;;5493:869;;;;;;;5682:3;5670:9;5661:7;5657:23;5653:33;5650:2;;;5699:1;5696;5689:12;5650:2;5734:1;5751:53;5796:7;5787:6;5776:9;5772:22;5751:53;;;5741:63;;5713:97;5841:2;5859:53;5904:7;5895:6;5884:9;5880:22;5859:53;;;5849:63;;5820:98;5949:2;5967:53;6012:7;6003:6;5992:9;5988:22;5967:53;;;5957:63;;5928:98;6057:2;6075:53;6120:7;6111:6;6100:9;6096:22;6075:53;;;6065:63;;6036:98;6165:3;6184:53;6229:7;6220:6;6209:9;6205:22;6184:53;;;6174:63;;6144:99;6274:3;6293:53;6338:7;6329:6;6318:9;6314:22;6293:53;;;6283:63;;6253:99;5644:718;;;;;;;;;6369:995;;;;;;;;6575:3;6563:9;6554:7;6550:23;6546:33;6543:2;;;6592:1;6589;6582:12;6543:2;6627:1;6644:53;6689:7;6680:6;6669:9;6665:22;6644:53;;;6634:63;;6606:97;6734:2;6752:53;6797:7;6788:6;6777:9;6773:22;6752:53;;;6742:63;;6713:98;6842:2;6860:53;6905:7;6896:6;6885:9;6881:22;6860:53;;;6850:63;;6821:98;6950:2;6968:53;7013:7;7004:6;6993:9;6989:22;6968:53;;;6958:63;;6929:98;7058:3;7077:53;7122:7;7113:6;7102:9;7098:22;7077:53;;;7067:63;;7037:99;7167:3;7186:53;7231:7;7222:6;7211:9;7207:22;7186:53;;;7176:63;;7146:99;7276:3;7295:53;7340:7;7331:6;7320:9;7316:22;7295:53;;;7285:63;;7255:99;6537:827;;;;;;;;;;;7371:1011;;;;;;7591:3;7579:9;7570:7;7566:23;7562:33;7559:2;;;7608:1;7605;7598:12;7559:2;7643:1;7660:53;7705:7;7696:6;7685:9;7681:22;7660:53;;;7650:63;;7622:97;7750:2;7768:53;7813:7;7804:6;7793:9;7789:22;7768:53;;;7758:63;;7729:98;7858:2;7876:51;7919:7;7910:6;7899:9;7895:22;7876:51;;;7866:61;;7837:96;7992:2;7981:9;7977:18;7964:32;8016:18;8008:6;8005:30;8002:2;;;8048:1;8045;8038:12;8002:2;8068:78;8138:7;8129:6;8118:9;8114:22;8068:78;;;8058:88;;7943:209;8211:3;8200:9;8196:19;8183:33;8236:18;8228:6;8225:30;8222:2;;;8268:1;8265;8258:12;8222:2;8288:78;8358:7;8349:6;8338:9;8334:22;8288:78;;;8278:88;;8162:210;7553:829;;;;;;;;;8389:365;;;8512:2;8500:9;8491:7;8487:23;8483:32;8480:2;;;8528:1;8525;8518:12;8480:2;8591:1;8580:9;8576:17;8563:31;8614:18;8606:6;8603:30;8600:2;;;8646:1;8643;8636:12;8600:2;8674:64;8730:7;8721:6;8710:9;8706:22;8674:64;;;8656:82;;;;8542:202;8474:280;;;;;;8761:735;;;;;;8932:3;8920:9;8911:7;8907:23;8903:33;8900:2;;;8949:1;8946;8939:12;8900:2;9012:1;9001:9;8997:17;8984:31;9035:18;9027:6;9024:30;9021:2;;;9067:1;9064;9057:12;9021:2;9095:64;9151:7;9142:6;9131:9;9127:22;9095:64;;;9077:82;;;;8963:202;9196:2;9214:50;9256:7;9247:6;9236:9;9232:22;9214:50;;;9204:60;;9175:95;9301:2;9319:53;9364:7;9355:6;9344:9;9340:22;9319:53;;;9309:63;;9280:98;9409:2;9427:53;9472:7;9463:6;9452:9;9448:22;9427:53;;;9417:63;;9388:98;8894:602;;;;;;;;;9503:261;;9617:2;9605:9;9596:7;9592:23;9588:32;9585:2;;;9633:1;9630;9623:12;9585:2;9668:1;9685:63;9740:7;9731:6;9720:9;9716:22;9685:63;;;9675:73;;9647:107;9579:185;;;;;9771:241;;9875:2;9863:9;9854:7;9850:23;9846:32;9843:2;;;9891:1;9888;9881:12;9843:2;9926:1;9943:53;9988:7;9979:6;9968:9;9964:22;9943:53;;;9933:63;;9905:97;9837:175;;;;;10019:263;;10134:2;10122:9;10113:7;10109:23;10105:32;10102:2;;;10150:1;10147;10140:12;10102:2;10185:1;10202:64;10258:7;10249:6;10238:9;10234:22;10202:64;;;10192:74;;10164:108;10096:186;;;;;10289:382;;;10418:2;10406:9;10397:7;10393:23;10389:32;10386:2;;;10434:1;10431;10424:12;10386:2;10469:1;10486:53;10531:7;10522:6;10511:9;10507:22;10486:53;;;10476:63;;10448:97;10576:2;10594:61;10647:7;10638:6;10627:9;10623:22;10594:61;;;10584:71;;10555:106;10380:291;;;;;;10678:259;;10791:2;10779:9;10770:7;10766:23;10762:32;10759:2;;;10807:1;10804;10797:12;10759:2;10842:1;10859:62;10913:7;10904:6;10893:9;10889:22;10859:62;;;10849:72;;10821:106;10753:184;;;;;10944:132;11025:45;11064:5;11025:45;;;11020:3;11013:58;11007:69;;;11083:134;11172:39;11205:5;11172:39;;;11167:3;11160:52;11154:63;;;11224:110;11297:31;11322:5;11297:31;;;11292:3;11285:44;11279:55;;;11372:590;;11507:54;11555:5;11507:54;;;11579:6;11574:3;11567:19;11603:4;11598:3;11594:14;11587:21;;11648:56;11698:5;11648:56;;;11725:1;11710:230;11735:6;11732:1;11729:13;11710:230;;;11775:53;11824:3;11815:6;11809:13;11775:53;;;11845:60;11898:6;11845:60;;;11835:70;;11928:4;11923:3;11919:14;11912:21;;11757:1;11754;11750:9;11745:14;;11710:230;;;11714:14;11953:3;11946:10;;11486:476;;;;;;;12033:718;;12204:70;12268:5;12204:70;;;12292:6;12287:3;12280:19;12316:4;12311:3;12307:14;12300:21;;12361:72;12427:5;12361:72;;;12454:1;12439:290;12464:6;12461:1;12458:13;12439:290;;;12504:97;12597:3;12588:6;12582:13;12504:97;;;12618:76;12687:6;12618:76;;;12608:86;;12717:4;12712:3;12708:14;12701:21;;12486:1;12483;12479:9;12474:14;;12439:290;;;12443:14;12742:3;12735:10;;12183:568;;;;;;;12759:101;12826:28;12848:5;12826:28;;;12821:3;12814:41;12808:52;;;12867:110;12940:31;12965:5;12940:31;;;12935:3;12928:44;12922:55;;;12984:107;13055:30;13079:5;13055:30;;;13050:3;13043:43;13037:54;;;13098:297;;13198:38;13230:5;13198:38;;;13253:6;13248:3;13241:19;13265:63;13321:6;13314:4;13309:3;13305:14;13298:4;13291:5;13287:16;13265:63;;;13360:29;13382:6;13360:29;;;13353:4;13348:3;13344:14;13340:50;13333:57;;13178:217;;;;;;13402:300;;13504:39;13537:5;13504:39;;;13560:6;13555:3;13548:19;13572:63;13628:6;13621:4;13616:3;13612:14;13605:4;13598:5;13594:16;13572:63;;;13667:29;13689:6;13667:29;;;13660:4;13655:3;13651:14;13647:50;13640:57;;13484:218;;;;;;13710:296;;13865:2;13860:3;13853:15;13902:66;13897:2;13892:3;13888:12;13881:88;13997:2;13992:3;13988:12;13981:19;;13846:160;;;;14015:397;;14170:2;14165:3;14158:15;14207:66;14202:2;14197:3;14193:12;14186:88;14308:66;14303:2;14298:3;14294:12;14287:88;14403:2;14398:3;14394:12;14387:19;;14151:261;;;;14421:296;;14576:2;14571:3;14564:15;14613:66;14608:2;14603:3;14599:12;14592:88;14708:2;14703:3;14699:12;14692:19;;14557:160;;;;14726:296;;14881:2;14876:3;14869:15;14918:66;14913:2;14908:3;14904:12;14897:88;15013:2;15008:3;15004:12;14997:19;;14862:160;;;;15031:397;;15186:2;15181:3;15174:15;15223:66;15218:2;15213:3;15209:12;15202:88;15324:66;15319:2;15314:3;15310:12;15303:88;15419:2;15414:3;15410:12;15403:19;;15167:261;;;;15437:296;;15592:2;15587:3;15580:15;15629:66;15624:2;15619:3;15615:12;15608:88;15724:2;15719:3;15715:12;15708:19;;15573:160;;;;15742:397;;15897:2;15892:3;15885:15;15934:66;15929:2;15924:3;15920:12;15913:88;16035:66;16030:2;16025:3;16021:12;16014:88;16130:2;16125:3;16121:12;16114:19;;15878:261;;;;16148:397;;16303:2;16298:3;16291:15;16340:66;16335:2;16330:3;16326:12;16319:88;16441:66;16436:2;16431:3;16427:12;16420:88;16536:2;16531:3;16527:12;16520:19;;16284:261;;;;16554:397;;16709:2;16704:3;16697:15;16746:66;16741:2;16736:3;16732:12;16725:88;16847:66;16842:2;16837:3;16833:12;16826:88;16942:2;16937:3;16933:12;16926:19;;16690:261;;;;16960:296;;17115:2;17110:3;17103:15;17152:66;17147:2;17142:3;17138:12;17131:88;17247:2;17242:3;17238:12;17231:19;;17096:160;;;;17265:296;;17420:2;17415:3;17408:15;17457:66;17452:2;17447:3;17443:12;17436:88;17552:2;17547:3;17543:12;17536:19;;17401:160;;;;17570:296;;17725:2;17720:3;17713:15;17762:66;17757:2;17752:3;17748:12;17741:88;17857:2;17852:3;17848:12;17841:19;;17706:160;;;;17875:397;;18030:2;18025:3;18018:15;18067:66;18062:2;18057:3;18053:12;18046:88;18168:66;18163:2;18158:3;18154:12;18147:88;18263:2;18258:3;18254:12;18247:19;;18011:261;;;;18281:397;;18436:2;18431:3;18424:15;18473:66;18468:2;18463:3;18459:12;18452:88;18574:66;18569:2;18564:3;18560:12;18553:88;18669:2;18664:3;18660:12;18653:19;;18417:261;;;;18687:296;;18842:2;18837:3;18830:15;18879:66;18874:2;18869:3;18865:12;18858:88;18974:2;18969:3;18965:12;18958:19;;18823:160;;;;18992:296;;19147:2;19142:3;19135:15;19184:66;19179:2;19174:3;19170:12;19163:88;19279:2;19274:3;19270:12;19263:19;;19128:160;;;;19297:397;;19452:2;19447:3;19440:15;19489:66;19484:2;19479:3;19475:12;19468:88;19590:66;19585:2;19580:3;19576:12;19569:88;19685:2;19680:3;19676:12;19669:19;;19433:261;;;;19703:296;;19858:2;19853:3;19846:15;19895:66;19890:2;19885:3;19881:12;19874:88;19990:2;19985:3;19981:12;19974:19;;19839:160;;;;20008:397;;20163:2;20158:3;20151:15;20200:66;20195:2;20190:3;20186:12;20179:88;20301:66;20296:2;20291:3;20287:12;20280:88;20396:2;20391:3;20387:12;20380:19;;20144:261;;;;20414:397;;20569:2;20564:3;20557:15;20606:66;20601:2;20596:3;20592:12;20585:88;20707:66;20702:2;20697:3;20693:12;20686:88;20802:2;20797:3;20793:12;20786:19;;20550:261;;;;20820:296;;20975:2;20970:3;20963:15;21012:66;21007:2;21002:3;20998:12;20991:88;21107:2;21102:3;21098:12;21091:19;;20956:160;;;;21125:296;;21280:2;21275:3;21268:15;21317:66;21312:2;21307:3;21303:12;21296:88;21412:2;21407:3;21403:12;21396:19;;21261:160;;;;21430:296;;21585:2;21580:3;21573:15;21622:66;21617:2;21612:3;21608:12;21601:88;21717:2;21712:3;21708:12;21701:19;;21566:160;;;;21735:296;;21890:2;21885:3;21878:15;21927:66;21922:2;21917:3;21913:12;21906:88;22022:2;22017:3;22013:12;22006:19;;21871:160;;;;22040:296;;22195:2;22190:3;22183:15;22232:66;22227:2;22222:3;22218:12;22211:88;22327:2;22322:3;22318:12;22311:19;;22176:160;;;;22345:296;;22500:2;22495:3;22488:15;22537:66;22532:2;22527:3;22523:12;22516:88;22632:2;22627:3;22623:12;22616:19;;22481:160;;;;22650:296;;22805:2;22800:3;22793:15;22842:66;22837:2;22832:3;22828:12;22821:88;22937:2;22932:3;22928:12;22921:19;;22786:160;;;;22955:296;;23110:2;23105:3;23098:15;23147:66;23142:2;23137:3;23133:12;23126:88;23242:2;23237:3;23233:12;23226:19;;23091:160;;;;23260:397;;23415:2;23410:3;23403:15;23452:66;23447:2;23442:3;23438:12;23431:88;23553:66;23548:2;23543:3;23539:12;23532:88;23648:2;23643:3;23639:12;23632:19;;23396:261;;;;23722:488;23849:4;23844:3;23840:14;23935:3;23928:5;23924:15;23918:22;23952:61;24008:3;24003;23999:13;23986:11;23952:61;;;23869:156;24103:4;24096:5;24092:16;24086:23;24121:62;24177:4;24172:3;24168:14;24155:11;24121:62;;;24035:160;23822:388;;;;24270:641;;24409:4;24404:3;24400:14;24495:3;24488:5;24484:15;24478:22;24512:61;24568:3;24563;24559:13;24546:11;24512:61;;;24429:156;24664:4;24657:5;24653:16;24647:23;24715:3;24709:4;24705:14;24698:4;24693:3;24689:14;24682:38;24735:138;24868:4;24855:11;24735:138;;;24727:146;;24595:290;24902:4;24895:11;;24382:529;;;;;;24918:110;24991:31;25016:5;24991:31;;;24986:3;24979:44;24973:55;;;25035:107;25106:30;25130:5;25106:30;;;25101:3;25094:43;25088:54;;;25149:193;;25257:2;25246:9;25242:18;25234:26;;25271:61;25329:1;25318:9;25314:17;25305:6;25271:61;;;25228:114;;;;;25349:209;;25465:2;25454:9;25450:18;25442:26;;25479:69;25545:1;25534:9;25530:17;25521:6;25479:69;;;25436:122;;;;;25565:290;;25699:2;25688:9;25684:18;25676:26;;25713:61;25771:1;25760:9;25756:17;25747:6;25713:61;;;25785:60;25841:2;25830:9;25826:18;25817:6;25785:60;;;25670:185;;;;;;25862:341;;26020:2;26009:9;26005:18;25997:26;;26070:9;26064:4;26060:20;26056:1;26045:9;26041:17;26034:47;26095:98;26188:4;26179:6;26095:98;;;26087:106;;25991:212;;;;;26210:181;;26312:2;26301:9;26297:18;26289:26;;26326:55;26378:1;26367:9;26363:17;26354:6;26326:55;;;26283:108;;;;;26398:193;;26506:2;26495:9;26491:18;26483:26;;26520:61;26578:1;26567:9;26563:17;26554:6;26520:61;;;26477:114;;;;;26598:281;;26726:2;26715:9;26711:18;26703:26;;26776:9;26770:4;26766:20;26762:1;26751:9;26747:17;26740:47;26801:68;26864:4;26855:6;26801:68;;;26793:76;;26697:182;;;;;26886:387;;27067:2;27056:9;27052:18;27044:26;;27117:9;27111:4;27107:20;27103:1;27092:9;27088:17;27081:47;27142:121;27258:4;27142:121;;;27134:129;;27038:235;;;;27280:387;;27461:2;27450:9;27446:18;27438:26;;27511:9;27505:4;27501:20;27497:1;27486:9;27482:17;27475:47;27536:121;27652:4;27536:121;;;27528:129;;27432:235;;;;27674:387;;27855:2;27844:9;27840:18;27832:26;;27905:9;27899:4;27895:20;27891:1;27880:9;27876:17;27869:47;27930:121;28046:4;27930:121;;;27922:129;;27826:235;;;;28068:387;;28249:2;28238:9;28234:18;28226:26;;28299:9;28293:4;28289:20;28285:1;28274:9;28270:17;28263:47;28324:121;28440:4;28324:121;;;28316:129;;28220:235;;;;28462:387;;28643:2;28632:9;28628:18;28620:26;;28693:9;28687:4;28683:20;28679:1;28668:9;28664:17;28657:47;28718:121;28834:4;28718:121;;;28710:129;;28614:235;;;;28856:387;;29037:2;29026:9;29022:18;29014:26;;29087:9;29081:4;29077:20;29073:1;29062:9;29058:17;29051:47;29112:121;29228:4;29112:121;;;29104:129;;29008:235;;;;29250:387;;29431:2;29420:9;29416:18;29408:26;;29481:9;29475:4;29471:20;29467:1;29456:9;29452:17;29445:47;29506:121;29622:4;29506:121;;;29498:129;;29402:235;;;;29644:387;;29825:2;29814:9;29810:18;29802:26;;29875:9;29869:4;29865:20;29861:1;29850:9;29846:17;29839:47;29900:121;30016:4;29900:121;;;29892:129;;29796:235;;;;30038:387;;30219:2;30208:9;30204:18;30196:26;;30269:9;30263:4;30259:20;30255:1;30244:9;30240:17;30233:47;30294:121;30410:4;30294:121;;;30286:129;;30190:235;;;;30432:387;;30613:2;30602:9;30598:18;30590:26;;30663:9;30657:4;30653:20;30649:1;30638:9;30634:17;30627:47;30688:121;30804:4;30688:121;;;30680:129;;30584:235;;;;30826:387;;31007:2;30996:9;30992:18;30984:26;;31057:9;31051:4;31047:20;31043:1;31032:9;31028:17;31021:47;31082:121;31198:4;31082:121;;;31074:129;;30978:235;;;;31220:387;;31401:2;31390:9;31386:18;31378:26;;31451:9;31445:4;31441:20;31437:1;31426:9;31422:17;31415:47;31476:121;31592:4;31476:121;;;31468:129;;31372:235;;;;31614:387;;31795:2;31784:9;31780:18;31772:26;;31845:9;31839:4;31835:20;31831:1;31820:9;31816:17;31809:47;31870:121;31986:4;31870:121;;;31862:129;;31766:235;;;;32008:387;;32189:2;32178:9;32174:18;32166:26;;32239:9;32233:4;32229:20;32225:1;32214:9;32210:17;32203:47;32264:121;32380:4;32264:121;;;32256:129;;32160:235;;;;32402:387;;32583:2;32572:9;32568:18;32560:26;;32633:9;32627:4;32623:20;32619:1;32608:9;32604:17;32597:47;32658:121;32774:4;32658:121;;;32650:129;;32554:235;;;;32796:387;;32977:2;32966:9;32962:18;32954:26;;33027:9;33021:4;33017:20;33013:1;33002:9;32998:17;32991:47;33052:121;33168:4;33052:121;;;33044:129;;32948:235;;;;33190:387;;33371:2;33360:9;33356:18;33348:26;;33421:9;33415:4;33411:20;33407:1;33396:9;33392:17;33385:47;33446:121;33562:4;33446:121;;;33438:129;;33342:235;;;;33584:387;;33765:2;33754:9;33750:18;33742:26;;33815:9;33809:4;33805:20;33801:1;33790:9;33786:17;33779:47;33840:121;33956:4;33840:121;;;33832:129;;33736:235;;;;33978:387;;34159:2;34148:9;34144:18;34136:26;;34209:9;34203:4;34199:20;34195:1;34184:9;34180:17;34173:47;34234:121;34350:4;34234:121;;;34226:129;;34130:235;;;;34372:387;;34553:2;34542:9;34538:18;34530:26;;34603:9;34597:4;34593:20;34589:1;34578:9;34574:17;34567:47;34628:121;34744:4;34628:121;;;34620:129;;34524:235;;;;34766:387;;34947:2;34936:9;34932:18;34924:26;;34997:9;34991:4;34987:20;34983:1;34972:9;34968:17;34961:47;35022:121;35138:4;35022:121;;;35014:129;;34918:235;;;;35160:387;;35341:2;35330:9;35326:18;35318:26;;35391:9;35385:4;35381:20;35377:1;35366:9;35362:17;35355:47;35416:121;35532:4;35416:121;;;35408:129;;35312:235;;;;35554:387;;35735:2;35724:9;35720:18;35712:26;;35785:9;35779:4;35775:20;35771:1;35760:9;35756:17;35749:47;35810:121;35926:4;35810:121;;;35802:129;;35706:235;;;;35948:387;;36129:2;36118:9;36114:18;36106:26;;36179:9;36173:4;36169:20;36165:1;36154:9;36150:17;36143:47;36204:121;36320:4;36204:121;;;36196:129;;36100:235;;;;36342:387;;36523:2;36512:9;36508:18;36500:26;;36573:9;36567:4;36563:20;36559:1;36548:9;36544:17;36537:47;36598:121;36714:4;36598:121;;;36590:129;;36494:235;;;;36736:387;;36917:2;36906:9;36902:18;36894:26;;36967:9;36961:4;36957:20;36953:1;36942:9;36938:17;36931:47;36992:121;37108:4;36992:121;;;36984:129;;36888:235;;;;37130:387;;37311:2;37300:9;37296:18;37288:26;;37361:9;37355:4;37351:20;37347:1;37336:9;37332:17;37325:47;37386:121;37502:4;37386:121;;;37378:129;;37282:235;;;;37524:387;;37705:2;37694:9;37690:18;37682:26;;37755:9;37749:4;37745:20;37741:1;37730:9;37726:17;37719:47;37780:121;37896:4;37780:121;;;37772:129;;37676:235;;;;37918:387;;38099:2;38088:9;38084:18;38076:26;;38149:9;38143:4;38139:20;38135:1;38124:9;38120:17;38113:47;38174:121;38290:4;38174:121;;;38166:129;;38070:235;;;;38312:337;;38468:2;38457:9;38453:18;38445:26;;38518:9;38512:4;38508:20;38504:1;38493:9;38489:17;38482:47;38543:96;38634:4;38625:6;38543:96;;;38535:104;;38439:210;;;;;38656:193;;38764:2;38753:9;38749:18;38741:26;;38778:61;38836:1;38825:9;38821:17;38812:6;38778:61;;;38735:114;;;;;38856:294;;38992:2;38981:9;38977:18;38969:26;;39006:61;39064:1;39053:9;39049:17;39040:6;39006:61;;;39078:62;39136:2;39125:9;39121:18;39112:6;39078:62;;;38963:187;;;;;;39157:326;;39309:2;39298:9;39294:18;39286:26;;39323:61;39381:1;39370:9;39366:17;39357:6;39323:61;;;39395:78;39469:2;39458:9;39454:18;39445:6;39395:78;;;39280:203;;;;;;39490:378;;39644:2;39633:9;39629:18;39621:26;;39658:61;39716:1;39705:9;39701:17;39692:6;39658:61;;;39767:9;39761:4;39757:20;39752:2;39741:9;39737:18;39730:48;39792:66;39853:4;39844:6;39792:66;;;39784:74;;39615:253;;;;;;39875:189;;39981:2;39970:9;39966:18;39958:26;;39995:59;40051:1;40040:9;40036:17;40027:6;39995:59;;;39952:112;;;;;40071:256;;40133:2;40127:9;40117:19;;40171:4;40163:6;40159:17;40270:6;40258:10;40255:22;40234:18;40222:10;40219:34;40216:62;40213:2;;;40291:1;40288;40281:12;40213:2;40311:10;40307:2;40300:22;40111:216;;;;;40334:258;;40493:18;40485:6;40482:30;40479:2;;;40525:1;40522;40515:12;40479:2;40554:4;40546:6;40542:17;40534:25;;40582:4;40576;40572:15;40564:23;;40416:176;;;;40601:121;;40710:4;40702:6;40698:17;40687:28;;40679:43;;;;40733:137;;40858:4;40850:6;40846:17;40835:28;;40827:43;;;;40879:107;;40975:5;40969:12;40959:22;;40953:33;;;;40993:123;;41105:5;41099:12;41089:22;;41083:33;;;;41123:91;;41203:5;41197:12;41187:22;;41181:33;;;;41221:92;;41302:5;41296:12;41286:22;;41280:33;;;;41321:122;;41432:4;41424:6;41420:17;41409:28;;41402:41;;;;41452:138;;41579:4;41571:6;41567:17;41556:28;;41549:41;;;;41598:105;;41667:31;41692:5;41667:31;;;41656:42;;41650:53;;;;41710:113;;41787:31;41812:5;41787:31;;;41776:42;;41770:53;;;;41830:92;;41910:5;41903:13;41896:21;41885:32;;41879:43;;;;41929:79;;41998:5;41987:16;;41981:27;;;;42015:151;;42094:66;42087:5;42083:78;42072:89;;42066:100;;;;42173:128;;42253:42;42246:5;42242:54;42231:65;;42225:76;;;;42308:79;;42377:5;42366:16;;42360:27;;;;42394:97;;42473:12;42466:5;42462:24;42451:35;;42445:46;;;;42498:105;;42567:31;42592:5;42567:31;;;42556:42;;42550:53;;;;42610:113;;42687:31;42712:5;42687:31;;;42676:42;;42670:53;;;;42730:92;;42810:5;42803:13;42796:21;42785:32;;42779:43;;;;42829:79;;42898:5;42887:16;;42881:27;;;;42915:91;;42994:6;42987:5;42983:18;42972:29;;42966:40;;;;43013:79;;43082:5;43071:16;;43065:27;;;;43099:88;;43177:4;43170:5;43166:16;43155:27;;43149:38;;;;43194:129;;43281:37;43312:5;43281:37;;;43268:50;;43262:61;;;;43330:121;;43409:37;43440:5;43409:37;;;43396:50;;43390:61;;;;43458:115;;43537:31;43562:5;43537:31;;;43524:44;;43518:55;;;;43581:268;43646:1;43653:101;43667:6;43664:1;43661:13;43653:101;;;43743:1;43738:3;43734:11;43728:18;43724:1;43719:3;43715:11;43708:39;43689:2;43686:1;43682:10;43677:15;;43653:101;;;43769:6;43766:1;43763:13;43760:2;;;43834:1;43825:6;43820:3;43816:16;43809:27;43760:2;43630:219;;;;;43857:97;;43945:2;43941:7;43936:2;43929:5;43925:14;43921:28;43911:38;;43905:49;;;";
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
		constant: false,
		inputs: [
			{
				name: "tableKey",
				type: "bytes32"
			},
			{
				name: "idTableKey",
				type: "bytes32"
			},
			{
				name: "fieldIdTableKey",
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
		constant: false,
		inputs: [
			{
				name: "tableKey",
				type: "bytes32"
			},
			{
				name: "idTableKey",
				type: "bytes32"
			},
			{
				name: "fieldIdTableKey",
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
		constant: false,
		inputs: [
			{
				name: "tableKey",
				type: "bytes32"
			},
			{
				name: "idTableKey",
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
		constant: false,
		inputs: [
			{
				name: "tableKey",
				type: "bytes32"
			},
			{
				name: "idTableKey",
				type: "bytes32"
			},
			{
				name: "idKey",
				type: "bytes32"
			},
			{
				name: "id",
				type: "bytes32"
			},
			{
				name: "fieldKey",
				type: "bytes32"
			},
			{
				name: "fieldIdTableKey",
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
			2209
		]
	},
	id: 2210,
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
			scope: 2210,
			sourceUnit: 8907,
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
			scope: 2210,
			sourceUnit: 6467,
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
			scope: 2210,
			sourceUnit: 10914,
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
			scope: 2210,
			sourceUnit: 4997,
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
			scope: 2210,
			sourceUnit: 3676,
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
			scope: 2210,
			sourceUnit: 3929,
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
			scope: 2210,
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
						referencedDeclaration: 4996,
						src: "805:10:2",
						typeDescriptions: {
							typeIdentifier: "t_contract$_OwnableELA_$4996",
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
						referencedDeclaration: 3675,
						src: "817:15:2",
						typeDescriptions: {
							typeIdentifier: "t_contract$_GSNRecipientELA_$3675",
							typeString: "contract GSNRecipientELA"
						}
					},
					id: 960,
					nodeType: "InheritanceSpecifier",
					src: "817:15:2"
				}
			],
			contractDependencies: [
				3612,
				3675,
				3979,
				4129,
				4803,
				4872,
				4996
			],
			contractKind: "contract",
			documentation: null,
			fullyImplemented: true,
			id: 2209,
			linearizedBaseContracts: [
				2209,
				3675,
				4129,
				3612,
				3979,
				4996,
				4803,
				4872
			],
			name: "ELAJSStore",
			nodeType: "ContractDefinition",
			nodes: [
				{
					constant: true,
					id: 963,
					name: "dateTimeAddr",
					nodeType: "VariableDeclaration",
					scope: 2209,
					src: "969:81:2",
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
						src: "969:7:2",
						stateMutability: "nonpayable",
						typeDescriptions: {
							typeIdentifier: "t_address",
							typeString: "address"
						}
					},
					value: {
						argumentTypes: null,
						hexValue: "307845446232313161326442626445363230313234343031373765363562363845304136364534353331",
						id: 962,
						isConstant: false,
						isLValue: false,
						isPure: true,
						kind: "number",
						lValueRequested: false,
						nodeType: "Literal",
						src: "1008:42:2",
						subdenomination: null,
						typeDescriptions: {
							typeIdentifier: "t_address_payable",
							typeString: "address payable"
						},
						value: "0xEDb211a2dBbdE62012440177e65b68E0A66E4531"
					},
					visibility: "public"
				},
				{
					constant: false,
					id: 968,
					name: "dateTime",
					nodeType: "VariableDeclaration",
					scope: 2209,
					src: "1147:42:2",
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
						src: "1147:8:2",
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
								src: "1176:12:2",
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
							src: "1167:8:2",
							typeDescriptions: {
								typeIdentifier: "t_type$_t_contract$_DateTime_$956_$",
								typeString: "type(contract DateTime)"
							}
						},
						id: 967,
						isConstant: false,
						isLValue: false,
						isPure: true,
						kind: "typeConversion",
						lValueRequested: false,
						names: [
						],
						nodeType: "FunctionCall",
						src: "1167:22:2",
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
					scope: 2209,
					src: "1434:45:2",
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
							src: "1442:7:2",
							typeDescriptions: {
								typeIdentifier: "t_bytes32",
								typeString: "bytes32"
							}
						},
						nodeType: "Mapping",
						src: "1434:27:2",
						typeDescriptions: {
							typeIdentifier: "t_mapping$_t_bytes32_$_t_uint256_$",
							typeString: "mapping(bytes32 => uint256)"
						},
						valueType: {
							id: 970,
							name: "uint256",
							nodeType: "ElementaryTypeName",
							src: "1453:7:2",
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
					scope: 2209,
					src: "1538:31:2",
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
						src: "1538:6:2",
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
						referencedDeclaration: 8906,
						src: "1582:24:2",
						typeDescriptions: {
							typeIdentifier: "t_contract$_PolymorphicDictionaryLib_$8906",
							typeString: "library PolymorphicDictionaryLib"
						}
					},
					nodeType: "UsingForDirective",
					src: "1576:82:2",
					typeName: {
						contractScope: null,
						id: 976,
						name: "PolymorphicDictionaryLib.PolymorphicDictionary",
						nodeType: "UserDefinedTypeName",
						referencedDeclaration: 7410,
						src: "1611:46:2",
						typeDescriptions: {
							typeIdentifier: "t_struct$_PolymorphicDictionary_$7410_storage_ptr",
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
						referencedDeclaration: 6466,
						src: "1669:23:2",
						typeDescriptions: {
							typeIdentifier: "t_contract$_Bytes32SetDictionaryLib_$6466",
							typeString: "library Bytes32SetDictionaryLib"
						}
					},
					nodeType: "UsingForDirective",
					src: "1663:79:2",
					typeName: {
						contractScope: null,
						id: 979,
						name: "Bytes32SetDictionaryLib.Bytes32SetDictionary",
						nodeType: "UserDefinedTypeName",
						referencedDeclaration: 6170,
						src: "1697:44:2",
						typeDescriptions: {
							typeIdentifier: "t_struct$_Bytes32SetDictionary_$6170_storage_ptr",
							typeString: "struct Bytes32SetDictionaryLib.Bytes32SetDictionary"
						}
					}
				},
				{
					constant: false,
					id: 984,
					name: "_table",
					nodeType: "VariableDeclaration",
					scope: 2209,
					src: "2000:43:2",
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
							src: "2008:7:2",
							typeDescriptions: {
								typeIdentifier: "t_bytes32",
								typeString: "bytes32"
							}
						},
						nodeType: "Mapping",
						src: "2000:27:2",
						typeDescriptions: {
							typeIdentifier: "t_mapping$_t_bytes32_$_t_bytes32_$",
							typeString: "mapping(bytes32 => bytes32)"
						},
						valueType: {
							id: 982,
							name: "bytes32",
							nodeType: "ElementaryTypeName",
							src: "2019:7:2",
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
					scope: 2209,
					src: "2136:61:2",
					stateVariable: true,
					storageLocation: "default",
					typeDescriptions: {
						typeIdentifier: "t_struct$_Bytes32SetDictionary_$6170_storage",
						typeString: "struct Bytes32SetDictionaryLib.Bytes32SetDictionary"
					},
					typeName: {
						contractScope: null,
						id: 985,
						name: "Bytes32SetDictionaryLib.Bytes32SetDictionary",
						nodeType: "UserDefinedTypeName",
						referencedDeclaration: 6170,
						src: "2136:44:2",
						typeDescriptions: {
							typeIdentifier: "t_struct$_Bytes32SetDictionary_$6170_storage_ptr",
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
						referencedDeclaration: 10913,
						src: "2293:8:2",
						typeDescriptions: {
							typeIdentifier: "t_contract$_TableLib_$10913",
							typeString: "library TableLib"
						}
					},
					nodeType: "UsingForDirective",
					src: "2287:34:2",
					typeName: {
						contractScope: null,
						id: 988,
						name: "TableLib.Table",
						nodeType: "UserDefinedTypeName",
						referencedDeclaration: 10678,
						src: "2306:14:2",
						typeDescriptions: {
							typeIdentifier: "t_struct$_Table_$10678_storage_ptr",
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
						referencedDeclaration: 10913,
						src: "2332:8:2",
						typeDescriptions: {
							typeIdentifier: "t_contract$_TableLib_$10913",
							typeString: "library TableLib"
						}
					},
					nodeType: "UsingForDirective",
					src: "2326:25:2",
					typeName: {
						id: 991,
						name: "bytes",
						nodeType: "ElementaryTypeName",
						src: "2345:5:2",
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
					scope: 2209,
					src: "2513:106:2",
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
						src: "2513:7:2",
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
						src: "2553:66:2",
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
					scope: 2209,
					src: "2894:64:2",
					stateVariable: true,
					storageLocation: "default",
					typeDescriptions: {
						typeIdentifier: "t_struct$_PolymorphicDictionary_$7410_storage",
						typeString: "struct PolymorphicDictionaryLib.PolymorphicDictionary"
					},
					typeName: {
						contractScope: null,
						id: 996,
						name: "PolymorphicDictionaryLib.PolymorphicDictionary",
						nodeType: "UserDefinedTypeName",
						referencedDeclaration: 7410,
						src: "2894:46:2",
						typeDescriptions: {
							typeIdentifier: "t_struct$_PolymorphicDictionary_$7410_storage_ptr",
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
						src: "3106:111:2",
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
												referencedDeclaration: 10928,
												src: "3138:3:2",
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
											src: "3138:10:2",
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
											referencedDeclaration: 4996,
											src: "3116:10:2",
											typeDescriptions: {
												typeIdentifier: "t_type$_t_contract$_OwnableELA_$4996_$",
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
										referencedDeclaration: 4907,
										src: "3116:21:2",
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
									src: "3116:33:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 1008,
								nodeType: "ExpressionStatement",
								src: "3116:33:2"
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
											referencedDeclaration: 3675,
											src: "3159:15:2",
											typeDescriptions: {
												typeIdentifier: "t_type$_t_contract$_GSNRecipientELA_$3675_$",
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
										referencedDeclaration: 3638,
										src: "3159:26:2",
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
									src: "3159:28:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 1013,
								nodeType: "ExpressionStatement",
								src: "3159:28:2"
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
										src: "3197:11:2",
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
									src: "3197:13:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 1016,
								nodeType: "ExpressionStatement",
								src: "3197:13:2"
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
								referencedDeclaration: 4847,
								src: "3094:11:2",
								typeDescriptions: {
									typeIdentifier: "t_modifier$__$",
									typeString: "modifier ()"
								}
							},
							nodeType: "ModifierInvocation",
							src: "3094:11:2"
						}
					],
					name: "initialize",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 998,
						nodeType: "ParameterList",
						parameters: [
						],
						src: "3084:2:2"
					},
					returnParameters: {
						id: 1001,
						nodeType: "ParameterList",
						parameters: [
						],
						src: "3106:0:2"
					},
					scope: 2209,
					src: "3065:152:2",
					stateMutability: "nonpayable",
					superFunction: 3638,
					visibility: "public"
				},
				{
					body: {
						id: 1034,
						nodeType: "Block",
						src: "3255:247:2",
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
										src: "3265:17:2",
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
										src: "3285:4:2",
										subdenomination: null,
										typeDescriptions: {
											typeIdentifier: "t_rational_1000_by_1",
											typeString: "int_const 1000"
										},
										value: "1000"
									},
									src: "3265:24:2",
									typeDescriptions: {
										typeIdentifier: "t_uint40",
										typeString: "uint40"
									}
								},
								id: 1024,
								nodeType: "ExpressionStatement",
								src: "3265:24:2"
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
											src: "3425:13:2",
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
													referencedDeclaration: 8906,
													src: "3440:24:2",
													typeDescriptions: {
														typeIdentifier: "t_type$_t_contract$_PolymorphicDictionaryLib_$8906_$",
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
												referencedDeclaration: 7415,
												src: "3440:39:2",
												typeDescriptions: {
													typeIdentifier: "t_type$_t_enum$_DictionaryType_$7415_$",
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
											src: "3440:54:2",
											typeDescriptions: {
												typeIdentifier: "t_enum$_DictionaryType_$7415",
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
												typeIdentifier: "t_enum$_DictionaryType_$7415",
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
											src: "3409:8:2",
											typeDescriptions: {
												typeIdentifier: "t_struct$_PolymorphicDictionary_$7410_storage",
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
										referencedDeclaration: 8833,
										src: "3409:15:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_nonpayable$_t_struct$_PolymorphicDictionary_$7410_storage_ptr_$_t_bytes32_$_t_enum$_DictionaryType_$7415_$returns$_t_bool_$bound_to$_t_struct$_PolymorphicDictionary_$7410_storage_ptr_$",
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
									src: "3409:86:2",
									typeDescriptions: {
										typeIdentifier: "t_bool",
										typeString: "bool"
									}
								},
								id: 1033,
								nodeType: "ExpressionStatement",
								src: "3409:86:2"
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
						src: "3243:2:2"
					},
					returnParameters: {
						id: 1020,
						nodeType: "ParameterList",
						parameters: [
						],
						src: "3255:0:2"
					},
					scope: 2209,
					src: "3223:279:2",
					stateMutability: "nonpayable",
					superFunction: null,
					visibility: "internal"
				},
				{
					body: {
						id: 1102,
						nodeType: "Block",
						src: "4021:886:2",
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
													src: "4315:6:2",
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
													src: "4322:8:2",
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
												src: "4315:16:2",
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
												src: "4335:1:2",
												subdenomination: null,
												typeDescriptions: {
													typeIdentifier: "t_rational_0_by_1",
													typeString: "int_const 0"
												},
												value: "0"
											},
											src: "4315:21:2",
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
											src: "4338:22:2",
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
											10931,
											10932
										],
										referencedDeclaration: 10932,
										src: "4307:7:2",
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
									src: "4307:54:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 1060,
								nodeType: "ExpressionStatement",
								src: "4307:54:2"
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
										src: "4372:16:2",
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
											src: "4372:7:2",
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
											src: "4399:3:2",
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
										src: "4391:7:2",
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
									src: "4391:12:2",
									typeDescriptions: {
										typeIdentifier: "t_address_payable",
										typeString: "address payable"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "4372:31:2"
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
											src: "4482:8:2",
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
											src: "4492:10:2",
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
											src: "4504:8:2",
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
										referencedDeclaration: 1958,
										src: "4465:16:2",
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
									src: "4465:48:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 1072,
								nodeType: "ExpressionStatement",
								src: "4465:48:2"
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
											src: "4548:13:2",
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
											src: "4563:9:2",
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
											src: "4524:8:2",
											typeDescriptions: {
												typeIdentifier: "t_struct$_PolymorphicDictionary_$7410_storage",
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
										referencedDeclaration: 8572,
										src: "4524:23:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_nonpayable$_t_struct$_PolymorphicDictionary_$7410_storage_ptr_$_t_bytes32_$_t_bytes32_$returns$_t_bool_$bound_to$_t_struct$_PolymorphicDictionary_$7410_storage_ptr_$",
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
									src: "4524:49:2",
									typeDescriptions: {
										typeIdentifier: "t_bool",
										typeString: "bool"
									}
								},
								id: 1079,
								nodeType: "ExpressionStatement",
								src: "4524:49:2"
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
											src: "4668:8:2",
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
											src: "4653:7:2",
											typeDescriptions: {
												typeIdentifier: "t_struct$_Bytes32SetDictionary_$6170_storage",
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
										referencedDeclaration: 6186,
										src: "4653:14:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_nonpayable$_t_struct$_Bytes32SetDictionary_$6170_storage_ptr_$_t_bytes32_$returns$_t_bool_$bound_to$_t_struct$_Bytes32SetDictionary_$6170_storage_ptr_$",
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
									src: "4653:24:2",
									typeDescriptions: {
										typeIdentifier: "t_bool",
										typeString: "bool"
									}
								},
								id: 1085,
								nodeType: "ExpressionStatement",
								src: "4653:24:2"
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
										src: "4721:33:2",
										stateVariable: false,
										storageLocation: "memory",
										typeDescriptions: {
											typeIdentifier: "t_struct$_Table_$10678_memory_ptr",
											typeString: "struct TableLib.Table"
										},
										typeName: {
											contractScope: null,
											id: 1088,
											name: "TableLib.Table",
											nodeType: "UserDefinedTypeName",
											referencedDeclaration: 10678,
											src: "4721:14:2",
											typeDescriptions: {
												typeIdentifier: "t_struct$_Table_$10678_storage_ptr",
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
											src: "4786:9:2",
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
											src: "4809:11:2",
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
											src: "4834:12:2",
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
											referencedDeclaration: 10913,
											src: "4757:8:2",
											typeDescriptions: {
												typeIdentifier: "t_type$_t_contract$_TableLib_$10913_$",
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
										referencedDeclaration: 10778,
										src: "4757:15:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_pure$_t_bytes32_$_t_array$_t_bytes32_$dyn_memory_ptr_$_t_array$_t_bytes32_$dyn_memory_ptr_$returns$_t_struct$_Table_$10678_memory_ptr_$",
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
									src: "4757:99:2",
									typeDescriptions: {
										typeIdentifier: "t_struct$_Table_$10678_memory_ptr",
										typeString: "struct TableLib.Table memory"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "4721:135:2"
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
											src: "4878:8:2",
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
											src: "4888:11:2",
											typeDescriptions: {
												typeIdentifier: "t_struct$_Table_$10678_memory_ptr",
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
												typeIdentifier: "t_struct$_Table_$10678_memory_ptr",
												typeString: "struct TableLib.Table memory"
											}
										],
										id: 1097,
										name: "saveSchema",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 1148,
										src: "4867:10:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_nonpayable$_t_bytes32_$_t_struct$_Table_$10678_memory_ptr_$returns$_t_bool_$",
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
									src: "4867:33:2",
									typeDescriptions: {
										typeIdentifier: "t_bool",
										typeString: "bool"
									}
								},
								id: 1101,
								nodeType: "ExpressionStatement",
								src: "4867:33:2"
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
								referencedDeclaration: 4925,
								src: "4011:9:2",
								typeDescriptions: {
									typeIdentifier: "t_modifier$__$",
									typeString: "modifier ()"
								}
							},
							nodeType: "ModifierInvocation",
							src: "4011:9:2"
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
								src: "3850:17:2",
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
									src: "3850:7:2",
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
								src: "3877:16:2",
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
									src: "3877:7:2",
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
								src: "3903:16:2",
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
									src: "3903:5:2",
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
								src: "3929:28:2",
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
										src: "3929:7:2",
										typeDescriptions: {
											typeIdentifier: "t_bytes32",
											typeString: "bytes32"
										}
									},
									id: 1043,
									length: null,
									nodeType: "ArrayTypeName",
									src: "3929:9:2",
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
								src: "3967:29:2",
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
										src: "3967:7:2",
										typeDescriptions: {
											typeIdentifier: "t_bytes32",
											typeString: "bytes32"
										}
									},
									id: 1046,
									length: null,
									nodeType: "ArrayTypeName",
									src: "3967:9:2",
									typeDescriptions: {
										typeIdentifier: "t_array$_t_bytes32_$dyn_storage_ptr",
										typeString: "bytes32[]"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "3840:163:2"
					},
					returnParameters: {
						id: 1051,
						nodeType: "ParameterList",
						parameters: [
						],
						src: "4021:0:2"
					},
					scope: 2209,
					src: "3820:1087:2",
					stateMutability: "nonpayable",
					superFunction: null,
					visibility: "public"
				},
				{
					body: {
						id: 1125,
						nodeType: "Block",
						src: "5043:106:2",
						statements: [
							{
								expression: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1115,
											name: "schemasTables",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 995,
											src: "5080:13:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										{
											argumentTypes: null,
											id: 1116,
											name: "tableName",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1105,
											src: "5095:9:2",
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
											id: 1112,
											name: "database",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 997,
											src: "5053:8:2",
											typeDescriptions: {
												typeIdentifier: "t_struct$_PolymorphicDictionary_$7410_storage",
												typeString: "struct PolymorphicDictionaryLib.PolymorphicDictionary storage ref"
											}
										},
										id: 1114,
										isConstant: false,
										isLValue: true,
										isPure: false,
										lValueRequested: false,
										memberName: "removeValueForKey",
										nodeType: "MemberAccess",
										referencedDeclaration: 8886,
										src: "5053:26:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_nonpayable$_t_struct$_PolymorphicDictionary_$7410_storage_ptr_$_t_bytes32_$_t_bytes32_$returns$_t_bool_$bound_to$_t_struct$_PolymorphicDictionary_$7410_storage_ptr_$",
											typeString: "function (struct PolymorphicDictionaryLib.PolymorphicDictionary storage pointer,bytes32,bytes32) returns (bool)"
										}
									},
									id: 1117,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "5053:52:2",
									typeDescriptions: {
										typeIdentifier: "t_bool",
										typeString: "bool"
									}
								},
								id: 1118,
								nodeType: "ExpressionStatement",
								src: "5053:52:2"
							},
							{
								expression: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1122,
											name: "tableKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1107,
											src: "5133:8:2",
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
											id: 1119,
											name: "tableId",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 986,
											src: "5115:7:2",
											typeDescriptions: {
												typeIdentifier: "t_struct$_Bytes32SetDictionary_$6170_storage",
												typeString: "struct Bytes32SetDictionaryLib.Bytes32SetDictionary storage ref"
											}
										},
										id: 1121,
										isConstant: false,
										isLValue: true,
										isPure: false,
										lValueRequested: false,
										memberName: "removeKey",
										nodeType: "MemberAccess",
										referencedDeclaration: 6299,
										src: "5115:17:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_nonpayable$_t_struct$_Bytes32SetDictionary_$6170_storage_ptr_$_t_bytes32_$returns$_t_bool_$bound_to$_t_struct$_Bytes32SetDictionary_$6170_storage_ptr_$",
											typeString: "function (struct Bytes32SetDictionaryLib.Bytes32SetDictionary storage pointer,bytes32) returns (bool)"
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
									src: "5115:27:2",
									typeDescriptions: {
										typeIdentifier: "t_bool",
										typeString: "bool"
									}
								},
								id: 1124,
								nodeType: "ExpressionStatement",
								src: "5115:27:2"
							}
						]
					},
					documentation: null,
					id: 1126,
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
								referencedDeclaration: 4925,
								src: "5033:9:2",
								typeDescriptions: {
									typeIdentifier: "t_modifier$__$",
									typeString: "modifier ()"
								}
							},
							nodeType: "ModifierInvocation",
							src: "5033:9:2"
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
								scope: 1126,
								src: "4976:17:2",
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
									src: "4976:7:2",
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
								scope: 1126,
								src: "5003:16:2",
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
									src: "5003:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "4966:59:2"
					},
					returnParameters: {
						id: 1111,
						nodeType: "ParameterList",
						parameters: [
						],
						src: "5043:0:2"
					},
					scope: 2209,
					src: "4946:203:2",
					stateMutability: "nonpayable",
					superFunction: null,
					visibility: "public"
				},
				{
					body: {
						id: 1147,
						nodeType: "Block",
						src: "5391:186:2",
						statements: [
							{
								assignments: [
									1136
								],
								declarations: [
									{
										constant: false,
										id: 1136,
										name: "encoded",
										nodeType: "VariableDeclaration",
										scope: 1147,
										src: "5401:20:2",
										stateVariable: false,
										storageLocation: "memory",
										typeDescriptions: {
											typeIdentifier: "t_bytes_memory_ptr",
											typeString: "bytes"
										},
										typeName: {
											id: 1135,
											name: "bytes",
											nodeType: "ElementaryTypeName",
											src: "5401:5:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes_storage_ptr",
												typeString: "bytes"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 1140,
								initialValue: {
									argumentTypes: null,
									"arguments": [
									],
									expression: {
										argumentTypes: [
										],
										expression: {
											argumentTypes: null,
											id: 1137,
											name: "tableSchema",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1130,
											src: "5424:11:2",
											typeDescriptions: {
												typeIdentifier: "t_struct$_Table_$10678_memory_ptr",
												typeString: "struct TableLib.Table memory"
											}
										},
										id: 1138,
										isConstant: false,
										isLValue: true,
										isPure: false,
										lValueRequested: false,
										memberName: "encode",
										nodeType: "MemberAccess",
										referencedDeclaration: 10830,
										src: "5424:18:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_pure$_t_struct$_Table_$10678_memory_ptr_$returns$_t_bytes_memory_ptr_$bound_to$_t_struct$_Table_$10678_memory_ptr_$",
											typeString: "function (struct TableLib.Table memory) pure returns (bytes memory)"
										}
									},
									id: 1139,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "5424:20:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes_memory_ptr",
										typeString: "bytes memory"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "5401:43:2"
							},
							{
								expression: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1143,
											name: "tableKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1128,
											src: "5552:8:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										{
											argumentTypes: null,
											id: 1144,
											name: "encoded",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1136,
											src: "5562:7:2",
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
											id: 1141,
											name: "database",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 997,
											src: "5528:8:2",
											typeDescriptions: {
												typeIdentifier: "t_struct$_PolymorphicDictionary_$7410_storage",
												typeString: "struct PolymorphicDictionaryLib.PolymorphicDictionary storage ref"
											}
										},
										id: 1142,
										isConstant: false,
										isLValue: true,
										isPure: false,
										lValueRequested: false,
										memberName: "setValueForKey",
										nodeType: "MemberAccess",
										referencedDeclaration: 8523,
										src: "5528:23:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_nonpayable$_t_struct$_PolymorphicDictionary_$7410_storage_ptr_$_t_bytes32_$_t_bytes_memory_ptr_$returns$_t_bool_$bound_to$_t_struct$_PolymorphicDictionary_$7410_storage_ptr_$",
											typeString: "function (struct PolymorphicDictionaryLib.PolymorphicDictionary storage pointer,bytes32,bytes memory) returns (bool)"
										}
									},
									id: 1145,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "5528:42:2",
									typeDescriptions: {
										typeIdentifier: "t_bool",
										typeString: "bool"
									}
								},
								functionReturnParameters: 1134,
								id: 1146,
								nodeType: "Return",
								src: "5521:49:2"
							}
						]
					},
					documentation: null,
					id: 1148,
					implemented: true,
					kind: "function",
					modifiers: [
					],
					name: "saveSchema",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 1131,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1128,
								name: "tableKey",
								nodeType: "VariableDeclaration",
								scope: 1148,
								src: "5314:16:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1127,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "5314:7:2",
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
								id: 1130,
								name: "tableSchema",
								nodeType: "VariableDeclaration",
								scope: 1148,
								src: "5332:33:2",
								stateVariable: false,
								storageLocation: "memory",
								typeDescriptions: {
									typeIdentifier: "t_struct$_Table_$10678_memory_ptr",
									typeString: "struct TableLib.Table"
								},
								typeName: {
									contractScope: null,
									id: 1129,
									name: "TableLib.Table",
									nodeType: "UserDefinedTypeName",
									referencedDeclaration: 10678,
									src: "5332:14:2",
									typeDescriptions: {
										typeIdentifier: "t_struct$_Table_$10678_storage_ptr",
										typeString: "struct TableLib.Table"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "5313:53:2"
					},
					returnParameters: {
						id: 1134,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1133,
								name: "",
								nodeType: "VariableDeclaration",
								scope: 1148,
								src: "5385:4:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bool",
									typeString: "bool"
								},
								typeName: {
									id: 1132,
									name: "bool",
									nodeType: "ElementaryTypeName",
									src: "5385:4:2",
									typeDescriptions: {
										typeIdentifier: "t_bool",
										typeString: "bool"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "5384:6:2"
					},
					scope: 2209,
					src: "5294:283:2",
					stateMutability: "nonpayable",
					superFunction: null,
					visibility: "internal"
				},
				{
					body: {
						id: 1166,
						nodeType: "Block",
						src: "5681:108:2",
						statements: [
							{
								assignments: [
									1156
								],
								declarations: [
									{
										constant: false,
										id: 1156,
										name: "encoded",
										nodeType: "VariableDeclaration",
										scope: 1166,
										src: "5691:20:2",
										stateVariable: false,
										storageLocation: "memory",
										typeDescriptions: {
											typeIdentifier: "t_bytes_memory_ptr",
											typeString: "bytes"
										},
										typeName: {
											id: 1155,
											name: "bytes",
											nodeType: "ElementaryTypeName",
											src: "5691:5:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes_storage_ptr",
												typeString: "bytes"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 1161,
								initialValue: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1159,
											name: "_name",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1150,
											src: "5738:5:2",
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
											id: 1157,
											name: "database",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 997,
											src: "5714:8:2",
											typeDescriptions: {
												typeIdentifier: "t_struct$_PolymorphicDictionary_$7410_storage",
												typeString: "struct PolymorphicDictionaryLib.PolymorphicDictionary storage ref"
											}
										},
										id: 1158,
										isConstant: false,
										isLValue: true,
										isPure: false,
										lValueRequested: false,
										memberName: "getBytesForKey",
										nodeType: "MemberAccess",
										referencedDeclaration: 7983,
										src: "5714:23:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_view$_t_struct$_PolymorphicDictionary_$7410_storage_ptr_$_t_bytes32_$returns$_t_bytes_memory_ptr_$bound_to$_t_struct$_PolymorphicDictionary_$7410_storage_ptr_$",
											typeString: "function (struct PolymorphicDictionaryLib.PolymorphicDictionary storage pointer,bytes32) view returns (bytes memory)"
										}
									},
									id: 1160,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "5714:30:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes_memory_ptr",
										typeString: "bytes memory"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "5691:53:2"
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
											id: 1162,
											name: "encoded",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1156,
											src: "5761:7:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes_memory_ptr",
												typeString: "bytes memory"
											}
										},
										id: 1163,
										isConstant: false,
										isLValue: false,
										isPure: false,
										lValueRequested: false,
										memberName: "decodeTable",
										nodeType: "MemberAccess",
										referencedDeclaration: 10879,
										src: "5761:19:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_pure$_t_bytes_memory_ptr_$returns$_t_struct$_Table_$10678_memory_ptr_$bound_to$_t_bytes_memory_ptr_$",
											typeString: "function (bytes memory) pure returns (struct TableLib.Table memory)"
										}
									},
									id: 1164,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "5761:21:2",
									typeDescriptions: {
										typeIdentifier: "t_struct$_Table_$10678_memory_ptr",
										typeString: "struct TableLib.Table memory"
									}
								},
								functionReturnParameters: 1154,
								id: 1165,
								nodeType: "Return",
								src: "5754:28:2"
							}
						]
					},
					documentation: null,
					id: 1167,
					implemented: true,
					kind: "function",
					modifiers: [
					],
					name: "getSchema",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 1151,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1150,
								name: "_name",
								nodeType: "VariableDeclaration",
								scope: 1167,
								src: "5622:13:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1149,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "5622:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "5621:15:2"
					},
					returnParameters: {
						id: 1154,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1153,
								name: "",
								nodeType: "VariableDeclaration",
								scope: 1167,
								src: "5658:21:2",
								stateVariable: false,
								storageLocation: "memory",
								typeDescriptions: {
									typeIdentifier: "t_struct$_Table_$10678_memory_ptr",
									typeString: "struct TableLib.Table"
								},
								typeName: {
									contractScope: null,
									id: 1152,
									name: "TableLib.Table",
									nodeType: "UserDefinedTypeName",
									referencedDeclaration: 10678,
									src: "5658:14:2",
									typeDescriptions: {
										typeIdentifier: "t_struct$_Table_$10678_storage_ptr",
										typeString: "struct TableLib.Table"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "5657:23:2"
					},
					scope: 2209,
					src: "5603:186:2",
					stateMutability: "view",
					superFunction: null,
					visibility: "public"
				},
				{
					body: {
						id: 1219,
						nodeType: "Block",
						src: "6026:615:2",
						statements: [
							{
								assignments: [
									1176,
									1178
								],
								declarations: [
									{
										constant: false,
										id: 1176,
										name: "permission",
										nodeType: "VariableDeclaration",
										scope: 1219,
										src: "6038:18:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										},
										typeName: {
											id: 1175,
											name: "uint256",
											nodeType: "ElementaryTypeName",
											src: "6038:7:2",
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
										id: 1178,
										name: "delegate",
										nodeType: "VariableDeclaration",
										scope: 1219,
										src: "6058:16:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_address",
											typeString: "address"
										},
										typeName: {
											id: 1177,
											name: "address",
											nodeType: "ElementaryTypeName",
											src: "6058:7:2",
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
								id: 1182,
								initialValue: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1180,
											name: "tableKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1169,
											src: "6095:8:2",
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
										id: 1179,
										name: "getTableMetadata",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 1923,
										src: "6078:16:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_view$_t_bytes32_$returns$_t_uint256_$_t_address_$",
											typeString: "function (bytes32) view returns (uint256,address)"
										}
									},
									id: 1181,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "6078:26:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$_t_uint256_$_t_address_$",
										typeString: "tuple(uint256,address)"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "6037:67:2"
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
											id: 1186,
											isConstant: false,
											isLValue: false,
											isPure: false,
											lValueRequested: false,
											leftExpression: {
												argumentTypes: null,
												id: 1184,
												name: "permission",
												nodeType: "Identifier",
												overloadedDeclarations: [
												],
												referencedDeclaration: 1176,
												src: "6187:10:2",
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
												id: 1185,
												isConstant: false,
												isLValue: false,
												isPure: true,
												kind: "number",
												lValueRequested: false,
												nodeType: "Literal",
												src: "6200:1:2",
												subdenomination: null,
												typeDescriptions: {
													typeIdentifier: "t_rational_0_by_1",
													typeString: "int_const 0"
												},
												value: "0"
											},
											src: "6187:14:2",
											typeDescriptions: {
												typeIdentifier: "t_bool",
												typeString: "bool"
											}
										},
										{
											argumentTypes: null,
											hexValue: "43616e6e6f7420494e5345525420696e746f2073797374656d207461626c65",
											id: 1187,
											isConstant: false,
											isLValue: false,
											isPure: true,
											kind: "string",
											lValueRequested: false,
											nodeType: "Literal",
											src: "6203:33:2",
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
										id: 1183,
										name: "require",
										nodeType: "Identifier",
										overloadedDeclarations: [
											10931,
											10932
										],
										referencedDeclaration: 10932,
										src: "6179:7:2",
										typeDescriptions: {
											typeIdentifier: "t_function_require_pure$_t_bool_$_t_string_memory_ptr_$returns$__$",
											typeString: "function (bool,string memory) pure"
										}
									},
									id: 1188,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "6179:58:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 1189,
								nodeType: "ExpressionStatement",
								src: "6179:58:2"
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
											id: 1203,
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
												id: 1198,
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
													id: 1193,
													isConstant: false,
													isLValue: false,
													isPure: false,
													lValueRequested: false,
													leftExpression: {
														argumentTypes: null,
														id: 1191,
														name: "permission",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 1176,
														src: "6316:10:2",
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
														id: 1192,
														isConstant: false,
														isLValue: false,
														isPure: true,
														kind: "number",
														lValueRequested: false,
														nodeType: "Literal",
														src: "6329:1:2",
														subdenomination: null,
														typeDescriptions: {
															typeIdentifier: "t_rational_1_by_1",
															typeString: "int_const 1"
														},
														value: "1"
													},
													src: "6316:14:2",
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
													id: 1197,
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
															id: 1194,
															name: "isOwner",
															nodeType: "Identifier",
															overloadedDeclarations: [
															],
															referencedDeclaration: 4936,
															src: "6334:7:2",
															typeDescriptions: {
																typeIdentifier: "t_function_internal_view$__$returns$_t_bool_$",
																typeString: "function () view returns (bool)"
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
														src: "6334:9:2",
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
														id: 1196,
														isConstant: false,
														isLValue: false,
														isPure: true,
														kind: "bool",
														lValueRequested: false,
														nodeType: "Literal",
														src: "6347:4:2",
														subdenomination: null,
														typeDescriptions: {
															typeIdentifier: "t_bool",
															typeString: "bool"
														},
														value: "true"
													},
													src: "6334:17:2",
													typeDescriptions: {
														typeIdentifier: "t_bool",
														typeString: "bool"
													}
												},
												src: "6316:35:2",
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
												id: 1202,
												isConstant: false,
												isLValue: false,
												isPure: false,
												lValueRequested: false,
												leftExpression: {
													argumentTypes: null,
													id: 1199,
													name: "delegate",
													nodeType: "Identifier",
													overloadedDeclarations: [
													],
													referencedDeclaration: 1178,
													src: "6355:8:2",
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
														id: 1200,
														name: "_msgSender",
														nodeType: "Identifier",
														overloadedDeclarations: [
															3527
														],
														referencedDeclaration: 3527,
														src: "6367:10:2",
														typeDescriptions: {
															typeIdentifier: "t_function_internal_view$__$returns$_t_address_$",
															typeString: "function () view returns (address)"
														}
													},
													id: 1201,
													isConstant: false,
													isLValue: false,
													isPure: false,
													kind: "functionCall",
													lValueRequested: false,
													names: [
													],
													nodeType: "FunctionCall",
													src: "6367:12:2",
													typeDescriptions: {
														typeIdentifier: "t_address",
														typeString: "address"
													}
												},
												src: "6355:24:2",
												typeDescriptions: {
													typeIdentifier: "t_bool",
													typeString: "bool"
												}
											},
											src: "6316:63:2",
											typeDescriptions: {
												typeIdentifier: "t_bool",
												typeString: "bool"
											}
										},
										{
											argumentTypes: null,
											hexValue: "4f6e6c79206f776e65722f64656c65676174652063616e20494e5345525420696e746f2074686973207461626c65",
											id: 1204,
											isConstant: false,
											isLValue: false,
											isPure: true,
											kind: "string",
											lValueRequested: false,
											nodeType: "Literal",
											src: "6381:48:2",
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
										id: 1190,
										name: "require",
										nodeType: "Identifier",
										overloadedDeclarations: [
											10931,
											10932
										],
										referencedDeclaration: 10932,
										src: "6308:7:2",
										typeDescriptions: {
											typeIdentifier: "t_function_require_pure$_t_bool_$_t_string_memory_ptr_$returns$__$",
											typeString: "function (bool,string memory) pure"
										}
									},
									id: 1205,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "6308:122:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 1206,
								nodeType: "ExpressionStatement",
								src: "6308:122:2"
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
											id: 1214,
											isConstant: false,
											isLValue: false,
											isPure: false,
											lValueRequested: false,
											leftExpression: {
												argumentTypes: null,
												"arguments": [
													{
														argumentTypes: null,
														id: 1209,
														name: "idKey",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 1171,
														src: "6544:5:2",
														typeDescriptions: {
															typeIdentifier: "t_bytes32",
															typeString: "bytes32"
														}
													},
													{
														argumentTypes: null,
														id: 1210,
														name: "tableKey",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 1169,
														src: "6551:8:2",
														typeDescriptions: {
															typeIdentifier: "t_bytes32",
															typeString: "bytes32"
														}
													},
													{
														argumentTypes: null,
														id: 1211,
														name: "idTableKey",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 1173,
														src: "6561:10:2",
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
													id: 1208,
													name: "isNamehashSubOf",
													nodeType: "Identifier",
													overloadedDeclarations: [
													],
													referencedDeclaration: 1880,
													src: "6528:15:2",
													typeDescriptions: {
														typeIdentifier: "t_function_internal_pure$_t_bytes32_$_t_bytes32_$_t_bytes32_$returns$_t_bool_$",
														typeString: "function (bytes32,bytes32,bytes32) pure returns (bool)"
													}
												},
												id: 1212,
												isConstant: false,
												isLValue: false,
												isPure: false,
												kind: "functionCall",
												lValueRequested: false,
												names: [
												],
												nodeType: "FunctionCall",
												src: "6528:44:2",
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
												id: 1213,
												isConstant: false,
												isLValue: false,
												isPure: true,
												kind: "bool",
												lValueRequested: false,
												nodeType: "Literal",
												src: "6576:4:2",
												subdenomination: null,
												typeDescriptions: {
													typeIdentifier: "t_bool",
													typeString: "bool"
												},
												value: "true"
											},
											src: "6528:52:2",
											typeDescriptions: {
												typeIdentifier: "t_bool",
												typeString: "bool"
											}
										},
										{
											argumentTypes: null,
											hexValue: "69645461626c654b6579206e6f7420612073756268617368205b69645d2e5b7461626c655d",
											id: 1215,
											isConstant: false,
											isLValue: false,
											isPure: true,
											kind: "string",
											lValueRequested: false,
											nodeType: "Literal",
											src: "6582:39:2",
											subdenomination: null,
											typeDescriptions: {
												typeIdentifier: "t_stringliteral_32e4c05ca8a5b34e37d3b74cb3500c0583d8bf5ba2edec98c710e79b95cc1e88",
												typeString: "literal_string \"idTableKey not a subhash [id].[table]\""
											},
											value: "idTableKey not a subhash [id].[table]"
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bool",
												typeString: "bool"
											},
											{
												typeIdentifier: "t_stringliteral_32e4c05ca8a5b34e37d3b74cb3500c0583d8bf5ba2edec98c710e79b95cc1e88",
												typeString: "literal_string \"idTableKey not a subhash [id].[table]\""
											}
										],
										id: 1207,
										name: "require",
										nodeType: "Identifier",
										overloadedDeclarations: [
											10931,
											10932
										],
										referencedDeclaration: 10932,
										src: "6520:7:2",
										typeDescriptions: {
											typeIdentifier: "t_function_require_pure$_t_bool_$_t_string_memory_ptr_$returns$__$",
											typeString: "function (bool,string memory) pure"
										}
									},
									id: 1216,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "6520:102:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 1217,
								nodeType: "ExpressionStatement",
								src: "6520:102:2"
							},
							{
								id: 1218,
								nodeType: "PlaceholderStatement",
								src: "6633:1:2"
							}
						]
					},
					documentation: "@dev Table level permission checks",
					id: 1220,
					name: "insertCheck",
					nodeType: "ModifierDefinition",
					parameters: {
						id: 1174,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1169,
								name: "tableKey",
								nodeType: "VariableDeclaration",
								scope: 1220,
								src: "5973:16:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1168,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "5973:7:2",
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
								id: 1171,
								name: "idKey",
								nodeType: "VariableDeclaration",
								scope: 1220,
								src: "5991:13:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1170,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "5991:7:2",
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
								id: 1173,
								name: "idTableKey",
								nodeType: "VariableDeclaration",
								scope: 1220,
								src: "6006:18:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1172,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "6006:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "5972:53:2"
					},
					src: "5952:689:2",
					visibility: "internal"
				},
				{
					body: {
						id: 1296,
						nodeType: "Block",
						src: "7302:917:2",
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
											id: 1248,
											isConstant: false,
											isLValue: false,
											isPure: false,
											lValueRequested: false,
											leftExpression: {
												argumentTypes: null,
												"arguments": [
													{
														argumentTypes: null,
														id: 1245,
														name: "fieldIdTableKey",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 1226,
														src: "7342:15:2",
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
														id: 1243,
														name: "database",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 997,
														src: "7321:8:2",
														typeDescriptions: {
															typeIdentifier: "t_struct$_PolymorphicDictionary_$7410_storage",
															typeString: "struct PolymorphicDictionaryLib.PolymorphicDictionary storage ref"
														}
													},
													id: 1244,
													isConstant: false,
													isLValue: true,
													isPure: false,
													lValueRequested: false,
													memberName: "containsKey",
													nodeType: "MemberAccess",
													referencedDeclaration: 7718,
													src: "7321:20:2",
													typeDescriptions: {
														typeIdentifier: "t_function_internal_view$_t_struct$_PolymorphicDictionary_$7410_storage_ptr_$_t_bytes32_$returns$_t_bool_$bound_to$_t_struct$_PolymorphicDictionary_$7410_storage_ptr_$",
														typeString: "function (struct PolymorphicDictionaryLib.PolymorphicDictionary storage pointer,bytes32) view returns (bool)"
													}
												},
												id: 1246,
												isConstant: false,
												isLValue: false,
												isPure: false,
												kind: "functionCall",
												lValueRequested: false,
												names: [
												],
												nodeType: "FunctionCall",
												src: "7321:37:2",
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
												id: 1247,
												isConstant: false,
												isLValue: false,
												isPure: true,
												kind: "bool",
												lValueRequested: false,
												nodeType: "Literal",
												src: "7362:5:2",
												subdenomination: null,
												typeDescriptions: {
													typeIdentifier: "t_bool",
													typeString: "bool"
												},
												value: "false"
											},
											src: "7321:46:2",
											typeDescriptions: {
												typeIdentifier: "t_bool",
												typeString: "bool"
											}
										},
										{
											argumentTypes: null,
											hexValue: "69642b6669656c6420616c726561647920657869737473",
											id: 1249,
											isConstant: false,
											isLValue: false,
											isPure: true,
											kind: "string",
											lValueRequested: false,
											nodeType: "Literal",
											src: "7369:25:2",
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
										id: 1242,
										name: "require",
										nodeType: "Identifier",
										overloadedDeclarations: [
											10931,
											10932
										],
										referencedDeclaration: 10932,
										src: "7313:7:2",
										typeDescriptions: {
											typeIdentifier: "t_function_require_pure$_t_bool_$_t_string_memory_ptr_$returns$__$",
											typeString: "function (bool,string memory) pure"
										}
									},
									id: 1250,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "7313:82:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 1251,
								nodeType: "ExpressionStatement",
								src: "7313:82:2"
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
														id: 1254,
														name: "fieldKey",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 1230,
														src: "7495:8:2",
														typeDescriptions: {
															typeIdentifier: "t_bytes32",
															typeString: "bytes32"
														}
													},
													{
														argumentTypes: null,
														id: 1255,
														name: "idTableKey",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 1224,
														src: "7505:10:2",
														typeDescriptions: {
															typeIdentifier: "t_bytes32",
															typeString: "bytes32"
														}
													},
													{
														argumentTypes: null,
														id: 1256,
														name: "fieldIdTableKey",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 1226,
														src: "7517:15:2",
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
													id: 1253,
													name: "isNamehashSubOf",
													nodeType: "Identifier",
													overloadedDeclarations: [
													],
													referencedDeclaration: 1880,
													src: "7479:15:2",
													typeDescriptions: {
														typeIdentifier: "t_function_internal_pure$_t_bytes32_$_t_bytes32_$_t_bytes32_$returns$_t_bool_$",
														typeString: "function (bytes32,bytes32,bytes32) pure returns (bool)"
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
												src: "7479:54:2",
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
												id: 1258,
												isConstant: false,
												isLValue: false,
												isPure: true,
												kind: "bool",
												lValueRequested: false,
												nodeType: "Literal",
												src: "7537:4:2",
												subdenomination: null,
												typeDescriptions: {
													typeIdentifier: "t_bool",
													typeString: "bool"
												},
												value: "true"
											},
											src: "7479:62:2",
											typeDescriptions: {
												typeIdentifier: "t_bool",
												typeString: "bool"
											}
										},
										{
											argumentTypes: null,
											hexValue: "6669656c644b6579206e6f7420612073756268617368205b6669656c645d2e5b69645d2e5b7461626c655d",
											id: 1260,
											isConstant: false,
											isLValue: false,
											isPure: true,
											kind: "string",
											lValueRequested: false,
											nodeType: "Literal",
											src: "7543:45:2",
											subdenomination: null,
											typeDescriptions: {
												typeIdentifier: "t_stringliteral_ffb24f5f0a8d53dbb9ae5d4e7b2c0f2217d28c61e321e2599160d24529f3bcc7",
												typeString: "literal_string \"fieldKey not a subhash [field].[id].[table]\""
											},
											value: "fieldKey not a subhash [field].[id].[table]"
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bool",
												typeString: "bool"
											},
											{
												typeIdentifier: "t_stringliteral_ffb24f5f0a8d53dbb9ae5d4e7b2c0f2217d28c61e321e2599160d24529f3bcc7",
												typeString: "literal_string \"fieldKey not a subhash [field].[id].[table]\""
											}
										],
										id: 1252,
										name: "require",
										nodeType: "Identifier",
										overloadedDeclarations: [
											10931,
											10932
										],
										referencedDeclaration: 10932,
										src: "7471:7:2",
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
									src: "7471:118:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 1262,
								nodeType: "ExpressionStatement",
								src: "7471:118:2"
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
										referencedDeclaration: 2048,
										src: "7629:18:2",
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
									src: "7629:20:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 1265,
								nodeType: "ExpressionStatement",
								src: "7629:20:2"
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
											referencedDeclaration: 1222,
											src: "7796:8:2",
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
											referencedDeclaration: 1232,
											src: "7806:2:2",
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
											src: "7773:7:2",
											typeDescriptions: {
												typeIdentifier: "t_struct$_Bytes32SetDictionary_$6170_storage",
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
										referencedDeclaration: 6274,
										src: "7773:22:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_nonpayable$_t_struct$_Bytes32SetDictionary_$6170_storage_ptr_$_t_bytes32_$_t_bytes32_$returns$_t_bool_$bound_to$_t_struct$_Bytes32SetDictionary_$6170_storage_ptr_$",
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
									src: "7773:36:2",
									typeDescriptions: {
										typeIdentifier: "t_bool",
										typeString: "bool"
									}
								},
								id: 1272,
								nodeType: "ExpressionStatement",
								src: "7773:36:2"
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
												referencedDeclaration: 1224,
												src: "7956:10:2",
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
												src: "7935:8:2",
												typeDescriptions: {
													typeIdentifier: "t_struct$_PolymorphicDictionary_$7410_storage",
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
											referencedDeclaration: 7718,
											src: "7935:20:2",
											typeDescriptions: {
												typeIdentifier: "t_function_internal_view$_t_struct$_PolymorphicDictionary_$7410_storage_ptr_$_t_bytes32_$returns$_t_bool_$bound_to$_t_struct$_PolymorphicDictionary_$7410_storage_ptr_$",
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
										src: "7935:32:2",
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
										src: "7971:5:2",
										subdenomination: null,
										typeDescriptions: {
											typeIdentifier: "t_bool",
											typeString: "bool"
										},
										value: "false"
									},
									src: "7935:41:2",
									typeDescriptions: {
										typeIdentifier: "t_bool",
										typeString: "bool"
									}
								},
								falseBody: null,
								id: 1286,
								nodeType: "IfStatement",
								src: "7931:109:2",
								trueBody: {
									id: 1285,
									nodeType: "Block",
									src: "7977:63:2",
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
														referencedDeclaration: 1224,
														src: "8004:10:2",
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
														referencedDeclaration: 1232,
														src: "8016:2:2",
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
														referencedDeclaration: 1222,
														src: "8020:8:2",
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
													referencedDeclaration: 1394,
													src: "7991:12:2",
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
												src: "7991:38:2",
												typeDescriptions: {
													typeIdentifier: "t_tuple$__$",
													typeString: "tuple()"
												}
											},
											id: 1284,
											nodeType: "ExpressionStatement",
											src: "7991:38:2"
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
											referencedDeclaration: 1226,
											src: "8181:15:2",
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
													referencedDeclaration: 1234,
													src: "8206:3:2",
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
												src: "8198:7:2",
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
											src: "8198:12:2",
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
											src: "8157:8:2",
											typeDescriptions: {
												typeIdentifier: "t_struct$_PolymorphicDictionary_$7410_storage",
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
										referencedDeclaration: 8376,
										src: "8157:23:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_nonpayable$_t_struct$_PolymorphicDictionary_$7410_storage_ptr_$_t_bytes32_$_t_bytes32_$returns$_t_bool_$bound_to$_t_struct$_PolymorphicDictionary_$7410_storage_ptr_$",
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
									src: "8157:54:2",
									typeDescriptions: {
										typeIdentifier: "t_bool",
										typeString: "bool"
									}
								},
								id: 1295,
								nodeType: "ExpressionStatement",
								src: "8157:54:2"
							}
						]
					},
					documentation: "@dev Prior to insert, we check the permissions and autoIncrement\nTODO: use the schema and determine the proper type of data to insert\n     * @param tableKey the namehashed [table] name string\n@param idKey the sha3 hashed idKey\n@param idTableKey the namehashed [id].[table] name string\n     * @param id as the raw string (unhashed)\n     *",
					id: 1297,
					implemented: true,
					kind: "function",
					modifiers: [
						{
							"arguments": [
								{
									argumentTypes: null,
									id: 1237,
									name: "tableKey",
									nodeType: "Identifier",
									overloadedDeclarations: [
									],
									referencedDeclaration: 1222,
									src: "7274:8:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								{
									argumentTypes: null,
									id: 1238,
									name: "idKey",
									nodeType: "Identifier",
									overloadedDeclarations: [
									],
									referencedDeclaration: 1228,
									src: "7284:5:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								{
									argumentTypes: null,
									id: 1239,
									name: "idTableKey",
									nodeType: "Identifier",
									overloadedDeclarations: [
									],
									referencedDeclaration: 1224,
									src: "7291:10:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								}
							],
							id: 1240,
							modifierName: {
								argumentTypes: null,
								id: 1236,
								name: "insertCheck",
								nodeType: "Identifier",
								overloadedDeclarations: [
								],
								referencedDeclaration: 1220,
								src: "7262:11:2",
								typeDescriptions: {
									typeIdentifier: "t_modifier$_t_bytes32_$_t_bytes32_$_t_bytes32_$",
									typeString: "modifier (bytes32,bytes32,bytes32)"
								}
							},
							nodeType: "ModifierInvocation",
							src: "7262:40:2"
						}
					],
					name: "insertVal",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 1235,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1222,
								name: "tableKey",
								nodeType: "VariableDeclaration",
								scope: 1297,
								src: "7079:16:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1221,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "7079:7:2",
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
								id: 1224,
								name: "idTableKey",
								nodeType: "VariableDeclaration",
								scope: 1297,
								src: "7105:18:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1223,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "7105:7:2",
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
								id: 1226,
								name: "fieldIdTableKey",
								nodeType: "VariableDeclaration",
								scope: 1297,
								src: "7133:23:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1225,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "7133:7:2",
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
								id: 1228,
								name: "idKey",
								nodeType: "VariableDeclaration",
								scope: 1297,
								src: "7167:13:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1227,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "7167:7:2",
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
								id: 1230,
								name: "fieldKey",
								nodeType: "VariableDeclaration",
								scope: 1297,
								src: "7190:16:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1229,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "7190:7:2",
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
								id: 1232,
								name: "id",
								nodeType: "VariableDeclaration",
								scope: 1297,
								src: "7217:10:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1231,
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
								id: 1234,
								name: "val",
								nodeType: "VariableDeclaration",
								scope: 1297,
								src: "7237:11:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1233,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "7237:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "7068:181:2"
					},
					returnParameters: {
						id: 1241,
						nodeType: "ParameterList",
						parameters: [
						],
						src: "7302:0:2"
					},
					scope: 2209,
					src: "7050:1169:2",
					stateMutability: "nonpayable",
					superFunction: null,
					visibility: "public"
				},
				{
					body: {
						id: 1393,
						nodeType: "Block",
						src: "9264:602:2",
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
											id: 1312,
											isConstant: false,
											isLValue: false,
											isPure: false,
											lValueRequested: false,
											leftExpression: {
												argumentTypes: null,
												"arguments": [
													{
														argumentTypes: null,
														id: 1309,
														name: "idTableKey",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 1299,
														src: "9304:10:2",
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
														id: 1307,
														name: "database",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 997,
														src: "9283:8:2",
														typeDescriptions: {
															typeIdentifier: "t_struct$_PolymorphicDictionary_$7410_storage",
															typeString: "struct PolymorphicDictionaryLib.PolymorphicDictionary storage ref"
														}
													},
													id: 1308,
													isConstant: false,
													isLValue: true,
													isPure: false,
													lValueRequested: false,
													memberName: "containsKey",
													nodeType: "MemberAccess",
													referencedDeclaration: 7718,
													src: "9283:20:2",
													typeDescriptions: {
														typeIdentifier: "t_function_internal_view$_t_struct$_PolymorphicDictionary_$7410_storage_ptr_$_t_bytes32_$returns$_t_bool_$bound_to$_t_struct$_PolymorphicDictionary_$7410_storage_ptr_$",
														typeString: "function (struct PolymorphicDictionaryLib.PolymorphicDictionary storage pointer,bytes32) view returns (bool)"
													}
												},
												id: 1310,
												isConstant: false,
												isLValue: false,
												isPure: false,
												kind: "functionCall",
												lValueRequested: false,
												names: [
												],
												nodeType: "FunctionCall",
												src: "9283:32:2",
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
												id: 1311,
												isConstant: false,
												isLValue: false,
												isPure: true,
												kind: "bool",
												lValueRequested: false,
												nodeType: "Literal",
												src: "9319:5:2",
												subdenomination: null,
												typeDescriptions: {
													typeIdentifier: "t_bool",
													typeString: "bool"
												},
												value: "false"
											},
											src: "9283:41:2",
											typeDescriptions: {
												typeIdentifier: "t_bool",
												typeString: "bool"
											}
										},
										{
											argumentTypes: null,
											hexValue: "726f7720616c726561647920686173206f776e6572",
											id: 1313,
											isConstant: false,
											isLValue: false,
											isPure: true,
											kind: "string",
											lValueRequested: false,
											nodeType: "Literal",
											src: "9326:23:2",
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
										id: 1306,
										name: "require",
										nodeType: "Identifier",
										overloadedDeclarations: [
											10931,
											10932
										],
										referencedDeclaration: 10932,
										src: "9275:7:2",
										typeDescriptions: {
											typeIdentifier: "t_function_require_pure$_t_bool_$_t_string_memory_ptr_$returns$__$",
											typeString: "function (bool,string memory) pure"
										}
									},
									id: 1314,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "9275:75:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 1315,
								nodeType: "ExpressionStatement",
								src: "9275:75:2"
							},
							{
								assignments: [
									1317
								],
								declarations: [
									{
										constant: false,
										id: 1317,
										name: "rowMetadata",
										nodeType: "VariableDeclaration",
										scope: 1393,
										src: "9361:19:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										},
										typeName: {
											id: 1316,
											name: "uint256",
											nodeType: "ElementaryTypeName",
											src: "9361:7:2",
											typeDescriptions: {
												typeIdentifier: "t_uint256",
												typeString: "uint256"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 1318,
								initialValue: null,
								nodeType: "VariableDeclarationStatement",
								src: "9361:19:2"
							},
							{
								assignments: [
									1320
								],
								declarations: [
									{
										constant: false,
										id: 1320,
										name: "year",
										nodeType: "VariableDeclaration",
										scope: 1393,
										src: "9391:11:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_uint16",
											typeString: "uint16"
										},
										typeName: {
											id: 1319,
											name: "uint16",
											nodeType: "ElementaryTypeName",
											src: "9391:6:2",
											typeDescriptions: {
												typeIdentifier: "t_uint16",
												typeString: "uint16"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 1325,
								initialValue: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1323,
											name: "now",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 10930,
											src: "9422:3:2",
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
											id: 1321,
											name: "dateTime",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 968,
											src: "9405:8:2",
											typeDescriptions: {
												typeIdentifier: "t_contract$_DateTime_$956",
												typeString: "contract DateTime"
											}
										},
										id: 1322,
										isConstant: false,
										isLValue: false,
										isPure: false,
										lValueRequested: false,
										memberName: "getYear",
										nodeType: "MemberAccess",
										referencedDeclaration: 941,
										src: "9405:16:2",
										typeDescriptions: {
											typeIdentifier: "t_function_external_pure$_t_uint256_$returns$_t_uint16_$",
											typeString: "function (uint256) pure external returns (uint16)"
										}
									},
									id: 1324,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "9405:21:2",
									typeDescriptions: {
										typeIdentifier: "t_uint16",
										typeString: "uint16"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "9391:35:2"
							},
							{
								assignments: [
									1327
								],
								declarations: [
									{
										constant: false,
										id: 1327,
										name: "month",
										nodeType: "VariableDeclaration",
										scope: 1393,
										src: "9436:11:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_uint8",
											typeString: "uint8"
										},
										typeName: {
											id: 1326,
											name: "uint8",
											nodeType: "ElementaryTypeName",
											src: "9436:5:2",
											typeDescriptions: {
												typeIdentifier: "t_uint8",
												typeString: "uint8"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 1332,
								initialValue: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1330,
											name: "now",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 10930,
											src: "9468:3:2",
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
											id: 1328,
											name: "dateTime",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 968,
											src: "9450:8:2",
											typeDescriptions: {
												typeIdentifier: "t_contract$_DateTime_$956",
												typeString: "contract DateTime"
											}
										},
										id: 1329,
										isConstant: false,
										isLValue: false,
										isPure: false,
										lValueRequested: false,
										memberName: "getMonth",
										nodeType: "MemberAccess",
										referencedDeclaration: 948,
										src: "9450:17:2",
										typeDescriptions: {
											typeIdentifier: "t_function_external_pure$_t_uint256_$returns$_t_uint8_$",
											typeString: "function (uint256) pure external returns (uint8)"
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
									src: "9450:22:2",
									typeDescriptions: {
										typeIdentifier: "t_uint8",
										typeString: "uint8"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "9436:36:2"
							},
							{
								assignments: [
									1334
								],
								declarations: [
									{
										constant: false,
										id: 1334,
										name: "day",
										nodeType: "VariableDeclaration",
										scope: 1393,
										src: "9482:9:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_uint8",
											typeString: "uint8"
										},
										typeName: {
											id: 1333,
											name: "uint8",
											nodeType: "ElementaryTypeName",
											src: "9482:5:2",
											typeDescriptions: {
												typeIdentifier: "t_uint8",
												typeString: "uint8"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 1339,
								initialValue: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1337,
											name: "now",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 10930,
											src: "9510:3:2",
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
											id: 1335,
											name: "dateTime",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 968,
											src: "9494:8:2",
											typeDescriptions: {
												typeIdentifier: "t_contract$_DateTime_$956",
												typeString: "contract DateTime"
											}
										},
										id: 1336,
										isConstant: false,
										isLValue: false,
										isPure: false,
										lValueRequested: false,
										memberName: "getDay",
										nodeType: "MemberAccess",
										referencedDeclaration: 955,
										src: "9494:15:2",
										typeDescriptions: {
											typeIdentifier: "t_function_external_pure$_t_uint256_$returns$_t_uint8_$",
											typeString: "function (uint256) pure external returns (uint8)"
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
									src: "9494:20:2",
									typeDescriptions: {
										typeIdentifier: "t_uint8",
										typeString: "uint8"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "9482:32:2"
							},
							{
								expression: {
									argumentTypes: null,
									id: 1342,
									isConstant: false,
									isLValue: false,
									isPure: false,
									lValueRequested: false,
									leftHandSide: {
										argumentTypes: null,
										id: 1340,
										name: "rowMetadata",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 1317,
										src: "9525:11:2",
										typeDescriptions: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										}
									},
									nodeType: "Assignment",
									operator: "|=",
									rightHandSide: {
										argumentTypes: null,
										id: 1341,
										name: "year",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 1320,
										src: "9540:4:2",
										typeDescriptions: {
											typeIdentifier: "t_uint16",
											typeString: "uint16"
										}
									},
									src: "9525:19:2",
									typeDescriptions: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									}
								},
								id: 1343,
								nodeType: "ExpressionStatement",
								src: "9525:19:2"
							},
							{
								expression: {
									argumentTypes: null,
									id: 1350,
									isConstant: false,
									isLValue: false,
									isPure: false,
									lValueRequested: false,
									leftHandSide: {
										argumentTypes: null,
										id: 1344,
										name: "rowMetadata",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 1317,
										src: "9554:11:2",
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
										id: 1349,
										isConstant: false,
										isLValue: false,
										isPure: false,
										lValueRequested: false,
										leftExpression: {
											argumentTypes: null,
											"arguments": [
												{
													argumentTypes: null,
													id: 1346,
													name: "month",
													nodeType: "Identifier",
													overloadedDeclarations: [
													],
													referencedDeclaration: 1327,
													src: "9577:5:2",
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
												id: 1345,
												isConstant: false,
												isLValue: false,
												isPure: true,
												lValueRequested: false,
												nodeType: "ElementaryTypeNameExpression",
												src: "9569:7:2",
												typeDescriptions: {
													typeIdentifier: "t_type$_t_uint256_$",
													typeString: "type(uint256)"
												},
												typeName: "uint256"
											},
											id: 1347,
											isConstant: false,
											isLValue: false,
											isPure: false,
											kind: "typeConversion",
											lValueRequested: false,
											names: [
											],
											nodeType: "FunctionCall",
											src: "9569:14:2",
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
											id: 1348,
											isConstant: false,
											isLValue: false,
											isPure: true,
											kind: "number",
											lValueRequested: false,
											nodeType: "Literal",
											src: "9585:2:2",
											subdenomination: null,
											typeDescriptions: {
												typeIdentifier: "t_rational_16_by_1",
												typeString: "int_const 16"
											},
											value: "16"
										},
										src: "9569:18:2",
										typeDescriptions: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										}
									},
									src: "9554:33:2",
									typeDescriptions: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									}
								},
								id: 1351,
								nodeType: "ExpressionStatement",
								src: "9554:33:2"
							},
							{
								expression: {
									argumentTypes: null,
									id: 1358,
									isConstant: false,
									isLValue: false,
									isPure: false,
									lValueRequested: false,
									leftHandSide: {
										argumentTypes: null,
										id: 1352,
										name: "rowMetadata",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 1317,
										src: "9597:11:2",
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
										id: 1357,
										isConstant: false,
										isLValue: false,
										isPure: false,
										lValueRequested: false,
										leftExpression: {
											argumentTypes: null,
											"arguments": [
												{
													argumentTypes: null,
													id: 1354,
													name: "day",
													nodeType: "Identifier",
													overloadedDeclarations: [
													],
													referencedDeclaration: 1334,
													src: "9620:3:2",
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
												id: 1353,
												isConstant: false,
												isLValue: false,
												isPure: true,
												lValueRequested: false,
												nodeType: "ElementaryTypeNameExpression",
												src: "9612:7:2",
												typeDescriptions: {
													typeIdentifier: "t_type$_t_uint256_$",
													typeString: "type(uint256)"
												},
												typeName: "uint256"
											},
											id: 1355,
											isConstant: false,
											isLValue: false,
											isPure: false,
											kind: "typeConversion",
											lValueRequested: false,
											names: [
											],
											nodeType: "FunctionCall",
											src: "9612:12:2",
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
											id: 1356,
											isConstant: false,
											isLValue: false,
											isPure: true,
											kind: "number",
											lValueRequested: false,
											nodeType: "Literal",
											src: "9626:2:2",
											subdenomination: null,
											typeDescriptions: {
												typeIdentifier: "t_rational_24_by_1",
												typeString: "int_const 24"
											},
											value: "24"
										},
										src: "9612:16:2",
										typeDescriptions: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										}
									},
									src: "9597:31:2",
									typeDescriptions: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									}
								},
								id: 1359,
								nodeType: "ExpressionStatement",
								src: "9597:31:2"
							},
							{
								assignments: [
									1361
								],
								declarations: [
									{
										constant: false,
										id: 1361,
										name: "createdDate",
										nodeType: "VariableDeclaration",
										scope: 1393,
										src: "9639:18:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_bytes4",
											typeString: "bytes4"
										},
										typeName: {
											id: 1360,
											name: "bytes4",
											nodeType: "ElementaryTypeName",
											src: "9639:6:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes4",
												typeString: "bytes4"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 1367,
								initialValue: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											"arguments": [
												{
													argumentTypes: null,
													id: 1364,
													name: "rowMetadata",
													nodeType: "Identifier",
													overloadedDeclarations: [
													],
													referencedDeclaration: 1317,
													src: "9674:11:2",
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
												id: 1363,
												isConstant: false,
												isLValue: false,
												isPure: true,
												lValueRequested: false,
												nodeType: "ElementaryTypeNameExpression",
												src: "9667:6:2",
												typeDescriptions: {
													typeIdentifier: "t_type$_t_uint32_$",
													typeString: "type(uint32)"
												},
												typeName: "uint32"
											},
											id: 1365,
											isConstant: false,
											isLValue: false,
											isPure: false,
											kind: "typeConversion",
											lValueRequested: false,
											names: [
											],
											nodeType: "FunctionCall",
											src: "9667:19:2",
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
										id: 1362,
										isConstant: false,
										isLValue: false,
										isPure: true,
										lValueRequested: false,
										nodeType: "ElementaryTypeNameExpression",
										src: "9660:6:2",
										typeDescriptions: {
											typeIdentifier: "t_type$_t_bytes4_$",
											typeString: "type(bytes4)"
										},
										typeName: "bytes4"
									},
									id: 1366,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "typeConversion",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "9660:27:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes4",
										typeString: "bytes4"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "9639:48:2"
							},
							{
								expression: {
									argumentTypes: null,
									id: 1375,
									isConstant: false,
									isLValue: false,
									isPure: false,
									lValueRequested: false,
									leftHandSide: {
										argumentTypes: null,
										id: 1368,
										name: "rowMetadata",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 1317,
										src: "9698:11:2",
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
										id: 1374,
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
														id: 1370,
														name: "_msgSender",
														nodeType: "Identifier",
														overloadedDeclarations: [
															3527
														],
														referencedDeclaration: 3527,
														src: "9721:10:2",
														typeDescriptions: {
															typeIdentifier: "t_function_internal_view$__$returns$_t_address_$",
															typeString: "function () view returns (address)"
														}
													},
													id: 1371,
													isConstant: false,
													isLValue: false,
													isPure: false,
													kind: "functionCall",
													lValueRequested: false,
													names: [
													],
													nodeType: "FunctionCall",
													src: "9721:12:2",
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
												id: 1369,
												isConstant: false,
												isLValue: false,
												isPure: true,
												lValueRequested: false,
												nodeType: "ElementaryTypeNameExpression",
												src: "9713:7:2",
												typeDescriptions: {
													typeIdentifier: "t_type$_t_uint256_$",
													typeString: "type(uint256)"
												},
												typeName: "uint256"
											},
											id: 1372,
											isConstant: false,
											isLValue: false,
											isPure: false,
											kind: "typeConversion",
											lValueRequested: false,
											names: [
											],
											nodeType: "FunctionCall",
											src: "9713:21:2",
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
											id: 1373,
											isConstant: false,
											isLValue: false,
											isPure: true,
											kind: "number",
											lValueRequested: false,
											nodeType: "Literal",
											src: "9736:2:2",
											subdenomination: null,
											typeDescriptions: {
												typeIdentifier: "t_rational_32_by_1",
												typeString: "int_const 32"
											},
											value: "32"
										},
										src: "9713:25:2",
										typeDescriptions: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										}
									},
									src: "9698:40:2",
									typeDescriptions: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									}
								},
								id: 1376,
								nodeType: "ExpressionStatement",
								src: "9698:40:2"
							},
							{
								expression: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1380,
											name: "idTableKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1299,
											src: "9773:10:2",
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
													id: 1382,
													name: "rowMetadata",
													nodeType: "Identifier",
													overloadedDeclarations: [
													],
													referencedDeclaration: 1317,
													src: "9793:11:2",
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
												id: 1381,
												isConstant: false,
												isLValue: false,
												isPure: true,
												lValueRequested: false,
												nodeType: "ElementaryTypeNameExpression",
												src: "9785:7:2",
												typeDescriptions: {
													typeIdentifier: "t_type$_t_bytes32_$",
													typeString: "type(bytes32)"
												},
												typeName: "bytes32"
											},
											id: 1383,
											isConstant: false,
											isLValue: false,
											isPure: false,
											kind: "typeConversion",
											lValueRequested: false,
											names: [
											],
											nodeType: "FunctionCall",
											src: "9785:20:2",
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
											id: 1377,
											name: "database",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 997,
											src: "9749:8:2",
											typeDescriptions: {
												typeIdentifier: "t_struct$_PolymorphicDictionary_$7410_storage",
												typeString: "struct PolymorphicDictionaryLib.PolymorphicDictionary storage ref"
											}
										},
										id: 1379,
										isConstant: false,
										isLValue: true,
										isPure: false,
										lValueRequested: false,
										memberName: "setValueForKey",
										nodeType: "MemberAccess",
										referencedDeclaration: 8376,
										src: "9749:23:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_nonpayable$_t_struct$_PolymorphicDictionary_$7410_storage_ptr_$_t_bytes32_$_t_bytes32_$returns$_t_bool_$bound_to$_t_struct$_PolymorphicDictionary_$7410_storage_ptr_$",
											typeString: "function (struct PolymorphicDictionaryLib.PolymorphicDictionary storage pointer,bytes32,bytes32) returns (bool)"
										}
									},
									id: 1384,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "9749:57:2",
									typeDescriptions: {
										typeIdentifier: "t_bool",
										typeString: "bool"
									}
								},
								id: 1385,
								nodeType: "ExpressionStatement",
								src: "9749:57:2"
							},
							{
								eventCall: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1387,
											name: "id",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1301,
											src: "9832:2:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										{
											argumentTypes: null,
											id: 1388,
											name: "tableKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1303,
											src: "9836:8:2",
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
												id: 1389,
												name: "_msgSender",
												nodeType: "Identifier",
												overloadedDeclarations: [
													3527
												],
												referencedDeclaration: 3527,
												src: "9846:10:2",
												typeDescriptions: {
													typeIdentifier: "t_function_internal_view$__$returns$_t_address_$",
													typeString: "function () view returns (address)"
												}
											},
											id: 1390,
											isConstant: false,
											isLValue: false,
											isPure: false,
											kind: "functionCall",
											lValueRequested: false,
											names: [
											],
											nodeType: "FunctionCall",
											src: "9846:12:2",
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
										id: 1386,
										name: "InsertRow",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 1402,
										src: "9822:9:2",
										typeDescriptions: {
											typeIdentifier: "t_function_event_nonpayable$_t_bytes32_$_t_bytes32_$_t_address_$returns$__$",
											typeString: "function (bytes32,bytes32,address)"
										}
									},
									id: 1391,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "9822:37:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 1392,
								nodeType: "EmitStatement",
								src: "9817:42:2"
							}
						]
					},
					documentation: "@dev we are essentially claiming this [id].[table] for the msg.sender, and setting the id createdDate",
					id: 1394,
					implemented: true,
					kind: "function",
					modifiers: [
					],
					name: "_setRowOwner",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 1304,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1299,
								name: "idTableKey",
								nodeType: "VariableDeclaration",
								scope: 1394,
								src: "9205:18:2",
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
									src: "9205:7:2",
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
								name: "id",
								nodeType: "VariableDeclaration",
								scope: 1394,
								src: "9225:10:2",
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
									src: "9225:7:2",
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
								name: "tableKey",
								nodeType: "VariableDeclaration",
								scope: 1394,
								src: "9237:16:2",
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
									src: "9237:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "9204:50:2"
					},
					returnParameters: {
						id: 1305,
						nodeType: "ParameterList",
						parameters: [
						],
						src: "9264:0:2"
					},
					scope: 2209,
					src: "9183:683:2",
					stateMutability: "nonpayable",
					superFunction: null,
					visibility: "internal"
				},
				{
					anonymous: false,
					documentation: null,
					id: 1402,
					name: "InsertRow",
					nodeType: "EventDefinition",
					parameters: {
						id: 1401,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1396,
								indexed: true,
								name: "_id",
								nodeType: "VariableDeclaration",
								scope: 1402,
								src: "9898:19:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1395,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "9898:7:2",
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
								id: 1398,
								indexed: true,
								name: "_tableKey",
								nodeType: "VariableDeclaration",
								scope: 1402,
								src: "9927:25:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1397,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "9927:7:2",
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
								id: 1400,
								indexed: true,
								name: "_rowOwner",
								nodeType: "VariableDeclaration",
								scope: 1402,
								src: "9962:25:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_address",
									typeString: "address"
								},
								typeName: {
									id: 1399,
									name: "address",
									nodeType: "ElementaryTypeName",
									src: "9962:7:2",
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
						src: "9888:105:2"
					},
					src: "9872:122:2"
				},
				{
					body: {
						id: 1436,
						nodeType: "Block",
						src: "10096:184:2",
						statements: [
							{
								assignments: [
									1412
								],
								declarations: [
									{
										constant: false,
										id: 1412,
										name: "rowMetadata",
										nodeType: "VariableDeclaration",
										scope: 1436,
										src: "10107:19:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										},
										typeName: {
											id: 1411,
											name: "uint256",
											nodeType: "ElementaryTypeName",
											src: "10107:7:2",
											typeDescriptions: {
												typeIdentifier: "t_uint256",
												typeString: "uint256"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 1419,
								initialValue: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											"arguments": [
												{
													argumentTypes: null,
													id: 1416,
													name: "idTableKey",
													nodeType: "Identifier",
													overloadedDeclarations: [
													],
													referencedDeclaration: 1404,
													src: "10163:10:2",
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
													id: 1414,
													name: "database",
													nodeType: "Identifier",
													overloadedDeclarations: [
													],
													referencedDeclaration: 997,
													src: "10137:8:2",
													typeDescriptions: {
														typeIdentifier: "t_struct$_PolymorphicDictionary_$7410_storage",
														typeString: "struct PolymorphicDictionaryLib.PolymorphicDictionary storage ref"
													}
												},
												id: 1415,
												isConstant: false,
												isLValue: true,
												isPure: false,
												lValueRequested: false,
												memberName: "getBytes32ForKey",
												nodeType: "MemberAccess",
												referencedDeclaration: 7891,
												src: "10137:25:2",
												typeDescriptions: {
													typeIdentifier: "t_function_internal_view$_t_struct$_PolymorphicDictionary_$7410_storage_ptr_$_t_bytes32_$returns$_t_bytes32_$bound_to$_t_struct$_PolymorphicDictionary_$7410_storage_ptr_$",
													typeString: "function (struct PolymorphicDictionaryLib.PolymorphicDictionary storage pointer,bytes32) view returns (bytes32)"
												}
											},
											id: 1417,
											isConstant: false,
											isLValue: false,
											isPure: false,
											kind: "functionCall",
											lValueRequested: false,
											names: [
											],
											nodeType: "FunctionCall",
											src: "10137:37:2",
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
										id: 1413,
										isConstant: false,
										isLValue: false,
										isPure: true,
										lValueRequested: false,
										nodeType: "ElementaryTypeNameExpression",
										src: "10129:7:2",
										typeDescriptions: {
											typeIdentifier: "t_type$_t_uint256_$",
											typeString: "type(uint256)"
										},
										typeName: "uint256"
									},
									id: 1418,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "typeConversion",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "10129:46:2",
									typeDescriptions: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "10107:68:2"
							},
							{
								expression: {
									argumentTypes: null,
									id: 1426,
									isConstant: false,
									isLValue: false,
									isPure: false,
									lValueRequested: false,
									leftHandSide: {
										argumentTypes: null,
										id: 1420,
										name: "createdDate",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 1409,
										src: "10186:11:2",
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
														id: 1423,
														name: "rowMetadata",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 1412,
														src: "10214:11:2",
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
													id: 1422,
													isConstant: false,
													isLValue: false,
													isPure: true,
													lValueRequested: false,
													nodeType: "ElementaryTypeNameExpression",
													src: "10207:6:2",
													typeDescriptions: {
														typeIdentifier: "t_type$_t_uint32_$",
														typeString: "type(uint32)"
													},
													typeName: "uint32"
												},
												id: 1424,
												isConstant: false,
												isLValue: false,
												isPure: false,
												kind: "typeConversion",
												lValueRequested: false,
												names: [
												],
												nodeType: "FunctionCall",
												src: "10207:19:2",
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
											id: 1421,
											isConstant: false,
											isLValue: false,
											isPure: true,
											lValueRequested: false,
											nodeType: "ElementaryTypeNameExpression",
											src: "10200:6:2",
											typeDescriptions: {
												typeIdentifier: "t_type$_t_bytes4_$",
												typeString: "type(bytes4)"
											},
											typeName: "bytes4"
										},
										id: 1425,
										isConstant: false,
										isLValue: false,
										isPure: false,
										kind: "typeConversion",
										lValueRequested: false,
										names: [
										],
										nodeType: "FunctionCall",
										src: "10200:27:2",
										typeDescriptions: {
											typeIdentifier: "t_bytes4",
											typeString: "bytes4"
										}
									},
									src: "10186:41:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes4",
										typeString: "bytes4"
									}
								},
								id: 1427,
								nodeType: "ExpressionStatement",
								src: "10186:41:2"
							},
							{
								expression: {
									argumentTypes: null,
									id: 1434,
									isConstant: false,
									isLValue: false,
									isPure: false,
									lValueRequested: false,
									leftHandSide: {
										argumentTypes: null,
										id: 1428,
										name: "rowOwner",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 1407,
										src: "10237:8:2",
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
												id: 1432,
												isConstant: false,
												isLValue: false,
												isPure: false,
												lValueRequested: false,
												leftExpression: {
													argumentTypes: null,
													id: 1430,
													name: "rowMetadata",
													nodeType: "Identifier",
													overloadedDeclarations: [
													],
													referencedDeclaration: 1412,
													src: "10256:11:2",
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
													id: 1431,
													isConstant: false,
													isLValue: false,
													isPure: true,
													kind: "number",
													lValueRequested: false,
													nodeType: "Literal",
													src: "10269:2:2",
													subdenomination: null,
													typeDescriptions: {
														typeIdentifier: "t_rational_32_by_1",
														typeString: "int_const 32"
													},
													value: "32"
												},
												src: "10256:15:2",
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
											id: 1429,
											isConstant: false,
											isLValue: false,
											isPure: true,
											lValueRequested: false,
											nodeType: "ElementaryTypeNameExpression",
											src: "10248:7:2",
											typeDescriptions: {
												typeIdentifier: "t_type$_t_address_$",
												typeString: "type(address)"
											},
											typeName: "address"
										},
										id: 1433,
										isConstant: false,
										isLValue: false,
										isPure: false,
										kind: "typeConversion",
										lValueRequested: false,
										names: [
										],
										nodeType: "FunctionCall",
										src: "10248:24:2",
										typeDescriptions: {
											typeIdentifier: "t_address_payable",
											typeString: "address payable"
										}
									},
									src: "10237:35:2",
									typeDescriptions: {
										typeIdentifier: "t_address",
										typeString: "address"
									}
								},
								id: 1435,
								nodeType: "ExpressionStatement",
								src: "10237:35:2"
							}
						]
					},
					documentation: null,
					id: 1437,
					implemented: true,
					kind: "function",
					modifiers: [
					],
					name: "getRowOwner",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 1405,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1404,
								name: "idTableKey",
								nodeType: "VariableDeclaration",
								scope: 1437,
								src: "10021:18:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1403,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "10021:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "10020:20:2"
					},
					returnParameters: {
						id: 1410,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1407,
								name: "rowOwner",
								nodeType: "VariableDeclaration",
								scope: 1437,
								src: "10059:16:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_address",
									typeString: "address"
								},
								typeName: {
									id: 1406,
									name: "address",
									nodeType: "ElementaryTypeName",
									src: "10059:7:2",
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
								id: 1409,
								name: "createdDate",
								nodeType: "VariableDeclaration",
								scope: 1437,
								src: "10077:18:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes4",
									typeString: "bytes4"
								},
								typeName: {
									id: 1408,
									name: "bytes4",
									nodeType: "ElementaryTypeName",
									src: "10077:6:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes4",
										typeString: "bytes4"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "10058:38:2"
					},
					scope: 2209,
					src: "10000:280:2",
					stateMutability: "nonpayable",
					superFunction: null,
					visibility: "external"
				},
				{
					body: {
						id: 1531,
						nodeType: "Block",
						src: "10360:1335:2",
						statements: [
							{
								assignments: [
									1446,
									1448
								],
								declarations: [
									{
										constant: false,
										id: 1446,
										name: "permission",
										nodeType: "VariableDeclaration",
										scope: 1531,
										src: "10372:18:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										},
										typeName: {
											id: 1445,
											name: "uint256",
											nodeType: "ElementaryTypeName",
											src: "10372:7:2",
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
										id: 1448,
										name: "delegate",
										nodeType: "VariableDeclaration",
										scope: 1531,
										src: "10392:16:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_address",
											typeString: "address"
										},
										typeName: {
											id: 1447,
											name: "address",
											nodeType: "ElementaryTypeName",
											src: "10392:7:2",
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
								id: 1452,
								initialValue: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1450,
											name: "tableKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1439,
											src: "10429:8:2",
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
										id: 1449,
										name: "getTableMetadata",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 1923,
										src: "10412:16:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_view$_t_bytes32_$returns$_t_uint256_$_t_address_$",
											typeString: "function (bytes32) view returns (uint256,address)"
										}
									},
									id: 1451,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "10412:26:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$_t_uint256_$_t_address_$",
										typeString: "tuple(uint256,address)"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "10371:67:2"
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
											id: 1456,
											isConstant: false,
											isLValue: false,
											isPure: false,
											lValueRequested: false,
											leftExpression: {
												argumentTypes: null,
												id: 1454,
												name: "permission",
												nodeType: "Identifier",
												overloadedDeclarations: [
												],
												referencedDeclaration: 1446,
												src: "10521:10:2",
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
												id: 1455,
												isConstant: false,
												isLValue: false,
												isPure: true,
												kind: "number",
												lValueRequested: false,
												nodeType: "Literal",
												src: "10534:1:2",
												subdenomination: null,
												typeDescriptions: {
													typeIdentifier: "t_rational_0_by_1",
													typeString: "int_const 0"
												},
												value: "0"
											},
											src: "10521:14:2",
											typeDescriptions: {
												typeIdentifier: "t_bool",
												typeString: "bool"
											}
										},
										{
											argumentTypes: null,
											hexValue: "43616e6e6f74205550444154452073797374656d207461626c65",
											id: 1457,
											isConstant: false,
											isLValue: false,
											isPure: true,
											kind: "string",
											lValueRequested: false,
											nodeType: "Literal",
											src: "10537:28:2",
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
										id: 1453,
										name: "require",
										nodeType: "Identifier",
										overloadedDeclarations: [
											10931,
											10932
										],
										referencedDeclaration: 10932,
										src: "10513:7:2",
										typeDescriptions: {
											typeIdentifier: "t_function_require_pure$_t_bool_$_t_string_memory_ptr_$returns$__$",
											typeString: "function (bool,string memory) pure"
										}
									},
									id: 1458,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "10513:53:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 1459,
								nodeType: "ExpressionStatement",
								src: "10513:53:2"
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
											id: 1473,
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
												id: 1468,
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
													id: 1463,
													isConstant: false,
													isLValue: false,
													isPure: false,
													lValueRequested: false,
													leftExpression: {
														argumentTypes: null,
														id: 1461,
														name: "permission",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 1446,
														src: "10645:10:2",
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
														id: 1462,
														isConstant: false,
														isLValue: false,
														isPure: true,
														kind: "number",
														lValueRequested: false,
														nodeType: "Literal",
														src: "10658:1:2",
														subdenomination: null,
														typeDescriptions: {
															typeIdentifier: "t_rational_1_by_1",
															typeString: "int_const 1"
														},
														value: "1"
													},
													src: "10645:14:2",
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
													id: 1467,
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
															id: 1464,
															name: "isOwner",
															nodeType: "Identifier",
															overloadedDeclarations: [
															],
															referencedDeclaration: 4936,
															src: "10663:7:2",
															typeDescriptions: {
																typeIdentifier: "t_function_internal_view$__$returns$_t_bool_$",
																typeString: "function () view returns (bool)"
															}
														},
														id: 1465,
														isConstant: false,
														isLValue: false,
														isPure: false,
														kind: "functionCall",
														lValueRequested: false,
														names: [
														],
														nodeType: "FunctionCall",
														src: "10663:9:2",
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
														id: 1466,
														isConstant: false,
														isLValue: false,
														isPure: true,
														kind: "bool",
														lValueRequested: false,
														nodeType: "Literal",
														src: "10676:4:2",
														subdenomination: null,
														typeDescriptions: {
															typeIdentifier: "t_bool",
															typeString: "bool"
														},
														value: "true"
													},
													src: "10663:17:2",
													typeDescriptions: {
														typeIdentifier: "t_bool",
														typeString: "bool"
													}
												},
												src: "10645:35:2",
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
												id: 1472,
												isConstant: false,
												isLValue: false,
												isPure: false,
												lValueRequested: false,
												leftExpression: {
													argumentTypes: null,
													id: 1469,
													name: "delegate",
													nodeType: "Identifier",
													overloadedDeclarations: [
													],
													referencedDeclaration: 1448,
													src: "10684:8:2",
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
														id: 1470,
														name: "_msgSender",
														nodeType: "Identifier",
														overloadedDeclarations: [
															3527
														],
														referencedDeclaration: 3527,
														src: "10696:10:2",
														typeDescriptions: {
															typeIdentifier: "t_function_internal_view$__$returns$_t_address_$",
															typeString: "function () view returns (address)"
														}
													},
													id: 1471,
													isConstant: false,
													isLValue: false,
													isPure: false,
													kind: "functionCall",
													lValueRequested: false,
													names: [
													],
													nodeType: "FunctionCall",
													src: "10696:12:2",
													typeDescriptions: {
														typeIdentifier: "t_address",
														typeString: "address"
													}
												},
												src: "10684:24:2",
												typeDescriptions: {
													typeIdentifier: "t_bool",
													typeString: "bool"
												}
											},
											src: "10645:63:2",
											typeDescriptions: {
												typeIdentifier: "t_bool",
												typeString: "bool"
											}
										},
										{
											argumentTypes: null,
											hexValue: "4f6e6c79206f776e65722f64656c65676174652063616e2055504441544520696e746f2074686973207461626c65",
											id: 1474,
											isConstant: false,
											isLValue: false,
											isPure: true,
											kind: "string",
											lValueRequested: false,
											nodeType: "Literal",
											src: "10710:48:2",
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
										id: 1460,
										name: "require",
										nodeType: "Identifier",
										overloadedDeclarations: [
											10931,
											10932
										],
										referencedDeclaration: 10932,
										src: "10637:7:2",
										typeDescriptions: {
											typeIdentifier: "t_function_require_pure$_t_bool_$_t_string_memory_ptr_$returns$__$",
											typeString: "function (bool,string memory) pure"
										}
									},
									id: 1475,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "10637:122:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 1476,
								nodeType: "ExpressionStatement",
								src: "10637:122:2"
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
											id: 1484,
											isConstant: false,
											isLValue: false,
											isPure: false,
											lValueRequested: false,
											leftExpression: {
												argumentTypes: null,
												"arguments": [
													{
														argumentTypes: null,
														id: 1479,
														name: "idKey",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 1441,
														src: "10873:5:2",
														typeDescriptions: {
															typeIdentifier: "t_bytes32",
															typeString: "bytes32"
														}
													},
													{
														argumentTypes: null,
														id: 1480,
														name: "tableKey",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 1439,
														src: "10880:8:2",
														typeDescriptions: {
															typeIdentifier: "t_bytes32",
															typeString: "bytes32"
														}
													},
													{
														argumentTypes: null,
														id: 1481,
														name: "idTableKey",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 1443,
														src: "10890:10:2",
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
													id: 1478,
													name: "isNamehashSubOf",
													nodeType: "Identifier",
													overloadedDeclarations: [
													],
													referencedDeclaration: 1880,
													src: "10857:15:2",
													typeDescriptions: {
														typeIdentifier: "t_function_internal_pure$_t_bytes32_$_t_bytes32_$_t_bytes32_$returns$_t_bool_$",
														typeString: "function (bytes32,bytes32,bytes32) pure returns (bool)"
													}
												},
												id: 1482,
												isConstant: false,
												isLValue: false,
												isPure: false,
												kind: "functionCall",
												lValueRequested: false,
												names: [
												],
												nodeType: "FunctionCall",
												src: "10857:44:2",
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
												id: 1483,
												isConstant: false,
												isLValue: false,
												isPure: true,
												kind: "bool",
												lValueRequested: false,
												nodeType: "Literal",
												src: "10905:4:2",
												subdenomination: null,
												typeDescriptions: {
													typeIdentifier: "t_bool",
													typeString: "bool"
												},
												value: "true"
											},
											src: "10857:52:2",
											typeDescriptions: {
												typeIdentifier: "t_bool",
												typeString: "bool"
											}
										},
										{
											argumentTypes: null,
											hexValue: "69645461626c654b6579206e6f7420612073756268617368205b69645d2e5b7461626c655d",
											id: 1485,
											isConstant: false,
											isLValue: false,
											isPure: true,
											kind: "string",
											lValueRequested: false,
											nodeType: "Literal",
											src: "10911:39:2",
											subdenomination: null,
											typeDescriptions: {
												typeIdentifier: "t_stringliteral_32e4c05ca8a5b34e37d3b74cb3500c0583d8bf5ba2edec98c710e79b95cc1e88",
												typeString: "literal_string \"idTableKey not a subhash [id].[table]\""
											},
											value: "idTableKey not a subhash [id].[table]"
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bool",
												typeString: "bool"
											},
											{
												typeIdentifier: "t_stringliteral_32e4c05ca8a5b34e37d3b74cb3500c0583d8bf5ba2edec98c710e79b95cc1e88",
												typeString: "literal_string \"idTableKey not a subhash [id].[table]\""
											}
										],
										id: 1477,
										name: "require",
										nodeType: "Identifier",
										overloadedDeclarations: [
											10931,
											10932
										],
										referencedDeclaration: 10932,
										src: "10849:7:2",
										typeDescriptions: {
											typeIdentifier: "t_function_require_pure$_t_bool_$_t_string_memory_ptr_$returns$__$",
											typeString: "function (bool,string memory) pure"
										}
									},
									id: 1486,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "10849:102:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 1487,
								nodeType: "ExpressionStatement",
								src: "10849:102:2"
							},
							{
								condition: {
									argumentTypes: null,
									commonType: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									},
									id: 1490,
									isConstant: false,
									isLValue: false,
									isPure: false,
									lValueRequested: false,
									leftExpression: {
										argumentTypes: null,
										id: 1488,
										name: "permission",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 1446,
										src: "11125:10:2",
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
										id: 1489,
										isConstant: false,
										isLValue: false,
										isPure: true,
										kind: "number",
										lValueRequested: false,
										nodeType: "Literal",
										src: "11139:1:2",
										subdenomination: null,
										typeDescriptions: {
											typeIdentifier: "t_rational_2_by_1",
											typeString: "int_const 2"
										},
										value: "2"
									},
									src: "11125:15:2",
									typeDescriptions: {
										typeIdentifier: "t_bool",
										typeString: "bool"
									}
								},
								falseBody: null,
								id: 1529,
								nodeType: "IfStatement",
								src: "11121:557:2",
								trueBody: {
									id: 1528,
									nodeType: "Block",
									src: "11142:536:2",
									statements: [
										{
											assignments: [
												1492
											],
											declarations: [
												{
													constant: false,
													id: 1492,
													name: "rowMetaData",
													nodeType: "VariableDeclaration",
													scope: 1528,
													src: "11238:19:2",
													stateVariable: false,
													storageLocation: "default",
													typeDescriptions: {
														typeIdentifier: "t_bytes32",
														typeString: "bytes32"
													},
													typeName: {
														id: 1491,
														name: "bytes32",
														nodeType: "ElementaryTypeName",
														src: "11238:7:2",
														typeDescriptions: {
															typeIdentifier: "t_bytes32",
															typeString: "bytes32"
														}
													},
													value: null,
													visibility: "internal"
												}
											],
											id: 1497,
											initialValue: {
												argumentTypes: null,
												"arguments": [
													{
														argumentTypes: null,
														id: 1495,
														name: "idTableKey",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 1443,
														src: "11286:10:2",
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
														id: 1493,
														name: "database",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 997,
														src: "11260:8:2",
														typeDescriptions: {
															typeIdentifier: "t_struct$_PolymorphicDictionary_$7410_storage",
															typeString: "struct PolymorphicDictionaryLib.PolymorphicDictionary storage ref"
														}
													},
													id: 1494,
													isConstant: false,
													isLValue: true,
													isPure: false,
													lValueRequested: false,
													memberName: "getBytes32ForKey",
													nodeType: "MemberAccess",
													referencedDeclaration: 7891,
													src: "11260:25:2",
													typeDescriptions: {
														typeIdentifier: "t_function_internal_view$_t_struct$_PolymorphicDictionary_$7410_storage_ptr_$_t_bytes32_$returns$_t_bytes32_$bound_to$_t_struct$_PolymorphicDictionary_$7410_storage_ptr_$",
														typeString: "function (struct PolymorphicDictionaryLib.PolymorphicDictionary storage pointer,bytes32) view returns (bytes32)"
													}
												},
												id: 1496,
												isConstant: false,
												isLValue: false,
												isPure: false,
												kind: "functionCall",
												lValueRequested: false,
												names: [
												],
												nodeType: "FunctionCall",
												src: "11260:37:2",
												typeDescriptions: {
													typeIdentifier: "t_bytes32",
													typeString: "bytes32"
												}
											},
											nodeType: "VariableDeclarationStatement",
											src: "11238:59:2"
										},
										{
											assignments: [
												1499
											],
											declarations: [
												{
													constant: false,
													id: 1499,
													name: "rowOwner",
													nodeType: "VariableDeclaration",
													scope: 1528,
													src: "11311:16:2",
													stateVariable: false,
													storageLocation: "default",
													typeDescriptions: {
														typeIdentifier: "t_address",
														typeString: "address"
													},
													typeName: {
														id: 1498,
														name: "address",
														nodeType: "ElementaryTypeName",
														src: "11311:7:2",
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
											id: 1507,
											initialValue: {
												argumentTypes: null,
												"arguments": [
													{
														argumentTypes: null,
														commonType: {
															typeIdentifier: "t_uint256",
															typeString: "uint256"
														},
														id: 1505,
														isConstant: false,
														isLValue: false,
														isPure: false,
														lValueRequested: false,
														leftExpression: {
															argumentTypes: null,
															"arguments": [
																{
																	argumentTypes: null,
																	id: 1502,
																	name: "rowMetaData",
																	nodeType: "Identifier",
																	overloadedDeclarations: [
																	],
																	referencedDeclaration: 1492,
																	src: "11346:11:2",
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
																id: 1501,
																isConstant: false,
																isLValue: false,
																isPure: true,
																lValueRequested: false,
																nodeType: "ElementaryTypeNameExpression",
																src: "11338:7:2",
																typeDescriptions: {
																	typeIdentifier: "t_type$_t_uint256_$",
																	typeString: "type(uint256)"
																},
																typeName: "uint256"
															},
															id: 1503,
															isConstant: false,
															isLValue: false,
															isPure: false,
															kind: "typeConversion",
															lValueRequested: false,
															names: [
															],
															nodeType: "FunctionCall",
															src: "11338:20:2",
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
															id: 1504,
															isConstant: false,
															isLValue: false,
															isPure: true,
															kind: "number",
															lValueRequested: false,
															nodeType: "Literal",
															src: "11360:2:2",
															subdenomination: null,
															typeDescriptions: {
																typeIdentifier: "t_rational_32_by_1",
																typeString: "int_const 32"
															},
															value: "32"
														},
														src: "11338:24:2",
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
													id: 1500,
													isConstant: false,
													isLValue: false,
													isPure: true,
													lValueRequested: false,
													nodeType: "ElementaryTypeNameExpression",
													src: "11330:7:2",
													typeDescriptions: {
														typeIdentifier: "t_type$_t_address_$",
														typeString: "type(address)"
													},
													typeName: "address"
												},
												id: 1506,
												isConstant: false,
												isLValue: false,
												isPure: false,
												kind: "typeConversion",
												lValueRequested: false,
												names: [
												],
												nodeType: "FunctionCall",
												src: "11330:33:2",
												typeDescriptions: {
													typeIdentifier: "t_address_payable",
													typeString: "address payable"
												}
											},
											nodeType: "VariableDeclarationStatement",
											src: "11311:52:2"
										},
										{
											condition: {
												argumentTypes: null,
												commonType: {
													typeIdentifier: "t_address",
													typeString: "address"
												},
												id: 1511,
												isConstant: false,
												isLValue: false,
												isPure: false,
												lValueRequested: false,
												leftExpression: {
													argumentTypes: null,
													id: 1508,
													name: "rowOwner",
													nodeType: "Identifier",
													overloadedDeclarations: [
													],
													referencedDeclaration: 1499,
													src: "11449:8:2",
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
														id: 1509,
														name: "_msgSender",
														nodeType: "Identifier",
														overloadedDeclarations: [
															3527
														],
														referencedDeclaration: 3527,
														src: "11461:10:2",
														typeDescriptions: {
															typeIdentifier: "t_function_internal_view$__$returns$_t_address_$",
															typeString: "function () view returns (address)"
														}
													},
													id: 1510,
													isConstant: false,
													isLValue: false,
													isPure: false,
													kind: "functionCall",
													lValueRequested: false,
													names: [
													],
													nodeType: "FunctionCall",
													src: "11461:12:2",
													typeDescriptions: {
														typeIdentifier: "t_address",
														typeString: "address"
													}
												},
												src: "11449:24:2",
												typeDescriptions: {
													typeIdentifier: "t_bool",
													typeString: "bool"
												}
											},
											falseBody: {
												id: 1526,
												nodeType: "Block",
												src: "11519:148:2",
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
																	id: 1522,
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
																		id: 1517,
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
																				id: 1514,
																				name: "isOwner",
																				nodeType: "Identifier",
																				overloadedDeclarations: [
																				],
																				referencedDeclaration: 4936,
																				src: "11545:7:2",
																				typeDescriptions: {
																					typeIdentifier: "t_function_internal_view$__$returns$_t_bool_$",
																					typeString: "function () view returns (bool)"
																				}
																			},
																			id: 1515,
																			isConstant: false,
																			isLValue: false,
																			isPure: false,
																			kind: "functionCall",
																			lValueRequested: false,
																			names: [
																			],
																			nodeType: "FunctionCall",
																			src: "11545:9:2",
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
																			id: 1516,
																			isConstant: false,
																			isLValue: false,
																			isPure: true,
																			kind: "bool",
																			lValueRequested: false,
																			nodeType: "Literal",
																			src: "11558:4:2",
																			subdenomination: null,
																			typeDescriptions: {
																				typeIdentifier: "t_bool",
																				typeString: "bool"
																			},
																			value: "true"
																		},
																		src: "11545:17:2",
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
																		id: 1521,
																		isConstant: false,
																		isLValue: false,
																		isPure: false,
																		lValueRequested: false,
																		leftExpression: {
																			argumentTypes: null,
																			id: 1518,
																			name: "delegate",
																			nodeType: "Identifier",
																			overloadedDeclarations: [
																			],
																			referencedDeclaration: 1448,
																			src: "11566:8:2",
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
																				id: 1519,
																				name: "_msgSender",
																				nodeType: "Identifier",
																				overloadedDeclarations: [
																					3527
																				],
																				referencedDeclaration: 3527,
																				src: "11578:10:2",
																				typeDescriptions: {
																					typeIdentifier: "t_function_internal_view$__$returns$_t_address_$",
																					typeString: "function () view returns (address)"
																				}
																			},
																			id: 1520,
																			isConstant: false,
																			isLValue: false,
																			isPure: false,
																			kind: "functionCall",
																			lValueRequested: false,
																			names: [
																			],
																			nodeType: "FunctionCall",
																			src: "11578:12:2",
																			typeDescriptions: {
																				typeIdentifier: "t_address",
																				typeString: "address"
																			}
																		},
																		src: "11566:24:2",
																		typeDescriptions: {
																			typeIdentifier: "t_bool",
																			typeString: "bool"
																		}
																	},
																	src: "11545:45:2",
																	typeDescriptions: {
																		typeIdentifier: "t_bool",
																		typeString: "bool"
																	}
																},
																{
																	argumentTypes: null,
																	hexValue: "4e6f7420726f774f776e6572206f72206f776e65722f64656c656761746520666f722055504441544520696e746f2074686973207461626c65",
																	id: 1523,
																	isConstant: false,
																	isLValue: false,
																	isPure: true,
																	kind: "string",
																	lValueRequested: false,
																	nodeType: "Literal",
																	src: "11592:59:2",
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
																id: 1513,
																name: "require",
																nodeType: "Identifier",
																overloadedDeclarations: [
																	10931,
																	10932
																],
																referencedDeclaration: 10932,
																src: "11537:7:2",
																typeDescriptions: {
																	typeIdentifier: "t_function_require_pure$_t_bool_$_t_string_memory_ptr_$returns$__$",
																	typeString: "function (bool,string memory) pure"
																}
															},
															id: 1524,
															isConstant: false,
															isLValue: false,
															isPure: false,
															kind: "functionCall",
															lValueRequested: false,
															names: [
															],
															nodeType: "FunctionCall",
															src: "11537:115:2",
															typeDescriptions: {
																typeIdentifier: "t_tuple$__$",
																typeString: "tuple()"
															}
														},
														id: 1525,
														nodeType: "ExpressionStatement",
														src: "11537:115:2"
													}
												]
											},
											id: 1527,
											nodeType: "IfStatement",
											src: "11445:222:2",
											trueBody: {
												id: 1512,
												nodeType: "Block",
												src: "11474:39:2",
												statements: [
												]
											}
										}
									]
								}
							},
							{
								id: 1530,
								nodeType: "PlaceholderStatement",
								src: "11687:1:2"
							}
						]
					},
					documentation: null,
					id: 1532,
					name: "updateCheck",
					nodeType: "ModifierDefinition",
					parameters: {
						id: 1444,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1439,
								name: "tableKey",
								nodeType: "VariableDeclaration",
								scope: 1532,
								src: "10307:16:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1438,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "10307:7:2",
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
								id: 1441,
								name: "idKey",
								nodeType: "VariableDeclaration",
								scope: 1532,
								src: "10325:13:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1440,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "10325:7:2",
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
								id: 1443,
								name: "idTableKey",
								nodeType: "VariableDeclaration",
								scope: 1532,
								src: "10340:18:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1442,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "10340:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "10306:53:2"
					},
					src: "10286:1409:2",
					visibility: "internal"
				},
				{
					body: {
						id: 1588,
						nodeType: "Block",
						src: "11954:460:2",
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
											id: 1561,
											isConstant: false,
											isLValue: false,
											isPure: false,
											lValueRequested: false,
											leftExpression: {
												argumentTypes: null,
												"arguments": [
													{
														argumentTypes: null,
														id: 1557,
														name: "tableKey",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 1534,
														src: "12001:8:2",
														typeDescriptions: {
															typeIdentifier: "t_bytes32",
															typeString: "bytes32"
														}
													},
													{
														argumentTypes: null,
														id: 1558,
														name: "id",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 1544,
														src: "12011:2:2",
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
														id: 1555,
														name: "tableId",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 986,
														src: "11973:7:2",
														typeDescriptions: {
															typeIdentifier: "t_struct$_Bytes32SetDictionary_$6170_storage",
															typeString: "struct Bytes32SetDictionaryLib.Bytes32SetDictionary storage ref"
														}
													},
													id: 1556,
													isConstant: false,
													isLValue: true,
													isPure: false,
													lValueRequested: false,
													memberName: "containsValueForKey",
													nodeType: "MemberAccess",
													referencedDeclaration: 6357,
													src: "11973:27:2",
													typeDescriptions: {
														typeIdentifier: "t_function_internal_view$_t_struct$_Bytes32SetDictionary_$6170_storage_ptr_$_t_bytes32_$_t_bytes32_$returns$_t_bool_$bound_to$_t_struct$_Bytes32SetDictionary_$6170_storage_ptr_$",
														typeString: "function (struct Bytes32SetDictionaryLib.Bytes32SetDictionary storage pointer,bytes32,bytes32) view returns (bool)"
													}
												},
												id: 1559,
												isConstant: false,
												isLValue: false,
												isPure: false,
												kind: "functionCall",
												lValueRequested: false,
												names: [
												],
												nodeType: "FunctionCall",
												src: "11973:41:2",
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
												id: 1560,
												isConstant: false,
												isLValue: false,
												isPure: true,
												kind: "bool",
												lValueRequested: false,
												nodeType: "Literal",
												src: "12018:4:2",
												subdenomination: null,
												typeDescriptions: {
													typeIdentifier: "t_bool",
													typeString: "bool"
												},
												value: "true"
											},
											src: "11973:49:2",
											typeDescriptions: {
												typeIdentifier: "t_bool",
												typeString: "bool"
											}
										},
										{
											argumentTypes: null,
											hexValue: "696420646f65736e27742065786973742c2075736520494e53455254",
											id: 1562,
											isConstant: false,
											isLValue: false,
											isPure: true,
											kind: "string",
											lValueRequested: false,
											nodeType: "Literal",
											src: "12024:30:2",
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
										id: 1554,
										name: "require",
										nodeType: "Identifier",
										overloadedDeclarations: [
											10931,
											10932
										],
										referencedDeclaration: 10932,
										src: "11965:7:2",
										typeDescriptions: {
											typeIdentifier: "t_function_require_pure$_t_bool_$_t_string_memory_ptr_$returns$__$",
											typeString: "function (bool,string memory) pure"
										}
									},
									id: 1563,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "11965:90:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 1564,
								nodeType: "ExpressionStatement",
								src: "11965:90:2"
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
											id: 1572,
											isConstant: false,
											isLValue: false,
											isPure: false,
											lValueRequested: false,
											leftExpression: {
												argumentTypes: null,
												"arguments": [
													{
														argumentTypes: null,
														id: 1567,
														name: "fieldKey",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 1542,
														src: "12155:8:2",
														typeDescriptions: {
															typeIdentifier: "t_bytes32",
															typeString: "bytes32"
														}
													},
													{
														argumentTypes: null,
														id: 1568,
														name: "idTableKey",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 1536,
														src: "12165:10:2",
														typeDescriptions: {
															typeIdentifier: "t_bytes32",
															typeString: "bytes32"
														}
													},
													{
														argumentTypes: null,
														id: 1569,
														name: "fieldIdTableKey",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 1538,
														src: "12177:15:2",
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
													id: 1566,
													name: "isNamehashSubOf",
													nodeType: "Identifier",
													overloadedDeclarations: [
													],
													referencedDeclaration: 1880,
													src: "12139:15:2",
													typeDescriptions: {
														typeIdentifier: "t_function_internal_pure$_t_bytes32_$_t_bytes32_$_t_bytes32_$returns$_t_bool_$",
														typeString: "function (bytes32,bytes32,bytes32) pure returns (bool)"
													}
												},
												id: 1570,
												isConstant: false,
												isLValue: false,
												isPure: false,
												kind: "functionCall",
												lValueRequested: false,
												names: [
												],
												nodeType: "FunctionCall",
												src: "12139:54:2",
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
												id: 1571,
												isConstant: false,
												isLValue: false,
												isPure: true,
												kind: "bool",
												lValueRequested: false,
												nodeType: "Literal",
												src: "12197:4:2",
												subdenomination: null,
												typeDescriptions: {
													typeIdentifier: "t_bool",
													typeString: "bool"
												},
												value: "true"
											},
											src: "12139:62:2",
											typeDescriptions: {
												typeIdentifier: "t_bool",
												typeString: "bool"
											}
										},
										{
											argumentTypes: null,
											hexValue: "6669656c644b6579206e6f7420612073756268617368205b6669656c645d2e5b69645d2e5b7461626c655d",
											id: 1573,
											isConstant: false,
											isLValue: false,
											isPure: true,
											kind: "string",
											lValueRequested: false,
											nodeType: "Literal",
											src: "12203:45:2",
											subdenomination: null,
											typeDescriptions: {
												typeIdentifier: "t_stringliteral_ffb24f5f0a8d53dbb9ae5d4e7b2c0f2217d28c61e321e2599160d24529f3bcc7",
												typeString: "literal_string \"fieldKey not a subhash [field].[id].[table]\""
											},
											value: "fieldKey not a subhash [field].[id].[table]"
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bool",
												typeString: "bool"
											},
											{
												typeIdentifier: "t_stringliteral_ffb24f5f0a8d53dbb9ae5d4e7b2c0f2217d28c61e321e2599160d24529f3bcc7",
												typeString: "literal_string \"fieldKey not a subhash [field].[id].[table]\""
											}
										],
										id: 1565,
										name: "require",
										nodeType: "Identifier",
										overloadedDeclarations: [
											10931,
											10932
										],
										referencedDeclaration: 10932,
										src: "12131:7:2",
										typeDescriptions: {
											typeIdentifier: "t_function_require_pure$_t_bool_$_t_string_memory_ptr_$returns$__$",
											typeString: "function (bool,string memory) pure"
										}
									},
									id: 1574,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "12131:118:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 1575,
								nodeType: "ExpressionStatement",
								src: "12131:118:2"
							},
							{
								expression: {
									argumentTypes: null,
									"arguments": [
									],
									expression: {
										argumentTypes: [
										],
										id: 1576,
										name: "increaseGsnCounter",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 2048,
										src: "12289:18:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_nonpayable$__$returns$__$",
											typeString: "function ()"
										}
									},
									id: 1577,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "12289:20:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 1578,
								nodeType: "ExpressionStatement",
								src: "12289:20:2"
							},
							{
								expression: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1582,
											name: "fieldIdTableKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1538,
											src: "12376:15:2",
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
													id: 1584,
													name: "val",
													nodeType: "Identifier",
													overloadedDeclarations: [
													],
													referencedDeclaration: 1546,
													src: "12401:3:2",
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
												id: 1583,
												isConstant: false,
												isLValue: false,
												isPure: true,
												lValueRequested: false,
												nodeType: "ElementaryTypeNameExpression",
												src: "12393:7:2",
												typeDescriptions: {
													typeIdentifier: "t_type$_t_bytes32_$",
													typeString: "type(bytes32)"
												},
												typeName: "bytes32"
											},
											id: 1585,
											isConstant: false,
											isLValue: false,
											isPure: false,
											kind: "typeConversion",
											lValueRequested: false,
											names: [
											],
											nodeType: "FunctionCall",
											src: "12393:12:2",
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
											id: 1579,
											name: "database",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 997,
											src: "12352:8:2",
											typeDescriptions: {
												typeIdentifier: "t_struct$_PolymorphicDictionary_$7410_storage",
												typeString: "struct PolymorphicDictionaryLib.PolymorphicDictionary storage ref"
											}
										},
										id: 1581,
										isConstant: false,
										isLValue: true,
										isPure: false,
										lValueRequested: false,
										memberName: "setValueForKey",
										nodeType: "MemberAccess",
										referencedDeclaration: 8376,
										src: "12352:23:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_nonpayable$_t_struct$_PolymorphicDictionary_$7410_storage_ptr_$_t_bytes32_$_t_bytes32_$returns$_t_bool_$bound_to$_t_struct$_PolymorphicDictionary_$7410_storage_ptr_$",
											typeString: "function (struct PolymorphicDictionaryLib.PolymorphicDictionary storage pointer,bytes32,bytes32) returns (bool)"
										}
									},
									id: 1586,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "12352:54:2",
									typeDescriptions: {
										typeIdentifier: "t_bool",
										typeString: "bool"
									}
								},
								id: 1587,
								nodeType: "ExpressionStatement",
								src: "12352:54:2"
							}
						]
					},
					documentation: null,
					id: 1589,
					implemented: true,
					kind: "function",
					modifiers: [
						{
							"arguments": [
								{
									argumentTypes: null,
									id: 1549,
									name: "tableKey",
									nodeType: "Identifier",
									overloadedDeclarations: [
									],
									referencedDeclaration: 1534,
									src: "11925:8:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								{
									argumentTypes: null,
									id: 1550,
									name: "idKey",
									nodeType: "Identifier",
									overloadedDeclarations: [
									],
									referencedDeclaration: 1540,
									src: "11935:5:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								{
									argumentTypes: null,
									id: 1551,
									name: "idTableKey",
									nodeType: "Identifier",
									overloadedDeclarations: [
									],
									referencedDeclaration: 1536,
									src: "11942:10:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								}
							],
							id: 1552,
							modifierName: {
								argumentTypes: null,
								id: 1548,
								name: "updateCheck",
								nodeType: "Identifier",
								overloadedDeclarations: [
								],
								referencedDeclaration: 1532,
								src: "11913:11:2",
								typeDescriptions: {
									typeIdentifier: "t_modifier$_t_bytes32_$_t_bytes32_$_t_bytes32_$",
									typeString: "modifier (bytes32,bytes32,bytes32)"
								}
							},
							nodeType: "ModifierInvocation",
							src: "11913:40:2"
						}
					],
					name: "updateVal",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 1547,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1534,
								name: "tableKey",
								nodeType: "VariableDeclaration",
								scope: 1589,
								src: "11730:16:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1533,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "11730:7:2",
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
								id: 1536,
								name: "idTableKey",
								nodeType: "VariableDeclaration",
								scope: 1589,
								src: "11756:18:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1535,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "11756:7:2",
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
								id: 1538,
								name: "fieldIdTableKey",
								nodeType: "VariableDeclaration",
								scope: 1589,
								src: "11784:23:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1537,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "11784:7:2",
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
								id: 1540,
								name: "idKey",
								nodeType: "VariableDeclaration",
								scope: 1589,
								src: "11818:13:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1539,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "11818:7:2",
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
								id: 1542,
								name: "fieldKey",
								nodeType: "VariableDeclaration",
								scope: 1589,
								src: "11841:16:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1541,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "11841:7:2",
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
								id: 1544,
								name: "id",
								nodeType: "VariableDeclaration",
								scope: 1589,
								src: "11868:10:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1543,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "11868:7:2",
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
								id: 1546,
								name: "val",
								nodeType: "VariableDeclaration",
								scope: 1589,
								src: "11888:11:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1545,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "11888:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "11719:181:2"
					},
					returnParameters: {
						id: 1553,
						nodeType: "ParameterList",
						parameters: [
						],
						src: "11954:0:2"
					},
					scope: 2209,
					src: "11701:713:2",
					stateMutability: "nonpayable",
					superFunction: null,
					visibility: "public"
				},
				{
					body: {
						id: 1694,
						nodeType: "Block",
						src: "12506:1330:2",
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
											id: 1606,
											isConstant: false,
											isLValue: false,
											isPure: false,
											lValueRequested: false,
											leftExpression: {
												argumentTypes: null,
												"arguments": [
													{
														argumentTypes: null,
														id: 1602,
														name: "tableKey",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 1591,
														src: "12553:8:2",
														typeDescriptions: {
															typeIdentifier: "t_bytes32",
															typeString: "bytes32"
														}
													},
													{
														argumentTypes: null,
														id: 1603,
														name: "id",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 1597,
														src: "12563:2:2",
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
														id: 1600,
														name: "tableId",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 986,
														src: "12525:7:2",
														typeDescriptions: {
															typeIdentifier: "t_struct$_Bytes32SetDictionary_$6170_storage",
															typeString: "struct Bytes32SetDictionaryLib.Bytes32SetDictionary storage ref"
														}
													},
													id: 1601,
													isConstant: false,
													isLValue: true,
													isPure: false,
													lValueRequested: false,
													memberName: "containsValueForKey",
													nodeType: "MemberAccess",
													referencedDeclaration: 6357,
													src: "12525:27:2",
													typeDescriptions: {
														typeIdentifier: "t_function_internal_view$_t_struct$_Bytes32SetDictionary_$6170_storage_ptr_$_t_bytes32_$_t_bytes32_$returns$_t_bool_$bound_to$_t_struct$_Bytes32SetDictionary_$6170_storage_ptr_$",
														typeString: "function (struct Bytes32SetDictionaryLib.Bytes32SetDictionary storage pointer,bytes32,bytes32) view returns (bool)"
													}
												},
												id: 1604,
												isConstant: false,
												isLValue: false,
												isPure: false,
												kind: "functionCall",
												lValueRequested: false,
												names: [
												],
												nodeType: "FunctionCall",
												src: "12525:41:2",
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
												id: 1605,
												isConstant: false,
												isLValue: false,
												isPure: true,
												kind: "bool",
												lValueRequested: false,
												nodeType: "Literal",
												src: "12570:4:2",
												subdenomination: null,
												typeDescriptions: {
													typeIdentifier: "t_bool",
													typeString: "bool"
												},
												value: "true"
											},
											src: "12525:49:2",
											typeDescriptions: {
												typeIdentifier: "t_bool",
												typeString: "bool"
											}
										},
										{
											argumentTypes: null,
											hexValue: "696420646f65736e2774206578697374",
											id: 1607,
											isConstant: false,
											isLValue: false,
											isPure: true,
											kind: "string",
											lValueRequested: false,
											nodeType: "Literal",
											src: "12576:18:2",
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
										id: 1599,
										name: "require",
										nodeType: "Identifier",
										overloadedDeclarations: [
											10931,
											10932
										],
										referencedDeclaration: 10932,
										src: "12517:7:2",
										typeDescriptions: {
											typeIdentifier: "t_function_require_pure$_t_bool_$_t_string_memory_ptr_$returns$__$",
											typeString: "function (bool,string memory) pure"
										}
									},
									id: 1608,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "12517:78:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 1609,
								nodeType: "ExpressionStatement",
								src: "12517:78:2"
							},
							{
								assignments: [
									1611,
									1613
								],
								declarations: [
									{
										constant: false,
										id: 1611,
										name: "permission",
										nodeType: "VariableDeclaration",
										scope: 1694,
										src: "12607:18:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										},
										typeName: {
											id: 1610,
											name: "uint256",
											nodeType: "ElementaryTypeName",
											src: "12607:7:2",
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
										id: 1613,
										name: "delegate",
										nodeType: "VariableDeclaration",
										scope: 1694,
										src: "12627:16:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_address",
											typeString: "address"
										},
										typeName: {
											id: 1612,
											name: "address",
											nodeType: "ElementaryTypeName",
											src: "12627:7:2",
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
								id: 1617,
								initialValue: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1615,
											name: "tableKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1591,
											src: "12664:8:2",
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
										id: 1614,
										name: "getTableMetadata",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 1923,
										src: "12647:16:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_view$_t_bytes32_$returns$_t_uint256_$_t_address_$",
											typeString: "function (bytes32) view returns (uint256,address)"
										}
									},
									id: 1616,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "12647:26:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$_t_uint256_$_t_address_$",
										typeString: "tuple(uint256,address)"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "12606:67:2"
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
											id: 1621,
											isConstant: false,
											isLValue: false,
											isPure: false,
											lValueRequested: false,
											leftExpression: {
												argumentTypes: null,
												id: 1619,
												name: "permission",
												nodeType: "Identifier",
												overloadedDeclarations: [
												],
												referencedDeclaration: 1611,
												src: "12756:10:2",
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
												id: 1620,
												isConstant: false,
												isLValue: false,
												isPure: true,
												kind: "number",
												lValueRequested: false,
												nodeType: "Literal",
												src: "12769:1:2",
												subdenomination: null,
												typeDescriptions: {
													typeIdentifier: "t_rational_0_by_1",
													typeString: "int_const 0"
												},
												value: "0"
											},
											src: "12756:14:2",
											typeDescriptions: {
												typeIdentifier: "t_bool",
												typeString: "bool"
											}
										},
										{
											argumentTypes: null,
											hexValue: "43616e6e6f742044454c4554452066726f6d2073797374656d207461626c65",
											id: 1622,
											isConstant: false,
											isLValue: false,
											isPure: true,
											kind: "string",
											lValueRequested: false,
											nodeType: "Literal",
											src: "12772:33:2",
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
										id: 1618,
										name: "require",
										nodeType: "Identifier",
										overloadedDeclarations: [
											10931,
											10932
										],
										referencedDeclaration: 10932,
										src: "12748:7:2",
										typeDescriptions: {
											typeIdentifier: "t_function_require_pure$_t_bool_$_t_string_memory_ptr_$returns$__$",
											typeString: "function (bool,string memory) pure"
										}
									},
									id: 1623,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "12748:58:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 1624,
								nodeType: "ExpressionStatement",
								src: "12748:58:2"
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
											id: 1638,
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
												id: 1633,
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
													id: 1628,
													isConstant: false,
													isLValue: false,
													isPure: false,
													lValueRequested: false,
													leftExpression: {
														argumentTypes: null,
														id: 1626,
														name: "permission",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 1611,
														src: "12885:10:2",
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
														id: 1627,
														isConstant: false,
														isLValue: false,
														isPure: true,
														kind: "number",
														lValueRequested: false,
														nodeType: "Literal",
														src: "12898:1:2",
														subdenomination: null,
														typeDescriptions: {
															typeIdentifier: "t_rational_1_by_1",
															typeString: "int_const 1"
														},
														value: "1"
													},
													src: "12885:14:2",
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
													id: 1632,
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
															id: 1629,
															name: "isOwner",
															nodeType: "Identifier",
															overloadedDeclarations: [
															],
															referencedDeclaration: 4936,
															src: "12903:7:2",
															typeDescriptions: {
																typeIdentifier: "t_function_internal_view$__$returns$_t_bool_$",
																typeString: "function () view returns (bool)"
															}
														},
														id: 1630,
														isConstant: false,
														isLValue: false,
														isPure: false,
														kind: "functionCall",
														lValueRequested: false,
														names: [
														],
														nodeType: "FunctionCall",
														src: "12903:9:2",
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
														id: 1631,
														isConstant: false,
														isLValue: false,
														isPure: true,
														kind: "bool",
														lValueRequested: false,
														nodeType: "Literal",
														src: "12916:4:2",
														subdenomination: null,
														typeDescriptions: {
															typeIdentifier: "t_bool",
															typeString: "bool"
														},
														value: "true"
													},
													src: "12903:17:2",
													typeDescriptions: {
														typeIdentifier: "t_bool",
														typeString: "bool"
													}
												},
												src: "12885:35:2",
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
												id: 1637,
												isConstant: false,
												isLValue: false,
												isPure: false,
												lValueRequested: false,
												leftExpression: {
													argumentTypes: null,
													id: 1634,
													name: "delegate",
													nodeType: "Identifier",
													overloadedDeclarations: [
													],
													referencedDeclaration: 1613,
													src: "12924:8:2",
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
														id: 1635,
														name: "_msgSender",
														nodeType: "Identifier",
														overloadedDeclarations: [
															3527
														],
														referencedDeclaration: 3527,
														src: "12936:10:2",
														typeDescriptions: {
															typeIdentifier: "t_function_internal_view$__$returns$_t_address_$",
															typeString: "function () view returns (address)"
														}
													},
													id: 1636,
													isConstant: false,
													isLValue: false,
													isPure: false,
													kind: "functionCall",
													lValueRequested: false,
													names: [
													],
													nodeType: "FunctionCall",
													src: "12936:12:2",
													typeDescriptions: {
														typeIdentifier: "t_address",
														typeString: "address"
													}
												},
												src: "12924:24:2",
												typeDescriptions: {
													typeIdentifier: "t_bool",
													typeString: "bool"
												}
											},
											src: "12885:63:2",
											typeDescriptions: {
												typeIdentifier: "t_bool",
												typeString: "bool"
											}
										},
										{
											argumentTypes: null,
											hexValue: "4f6e6c79206f776e65722f64656c65676174652063616e2044454c4554452066726f6d2074686973207461626c65",
											id: 1639,
											isConstant: false,
											isLValue: false,
											isPure: true,
											kind: "string",
											lValueRequested: false,
											nodeType: "Literal",
											src: "12950:48:2",
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
										id: 1625,
										name: "require",
										nodeType: "Identifier",
										overloadedDeclarations: [
											10931,
											10932
										],
										referencedDeclaration: 10932,
										src: "12877:7:2",
										typeDescriptions: {
											typeIdentifier: "t_function_require_pure$_t_bool_$_t_string_memory_ptr_$returns$__$",
											typeString: "function (bool,string memory) pure"
										}
									},
									id: 1640,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "12877:122:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 1641,
								nodeType: "ExpressionStatement",
								src: "12877:122:2"
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
											id: 1649,
											isConstant: false,
											isLValue: false,
											isPure: false,
											lValueRequested: false,
											leftExpression: {
												argumentTypes: null,
												"arguments": [
													{
														argumentTypes: null,
														id: 1644,
														name: "idKey",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 1595,
														src: "13113:5:2",
														typeDescriptions: {
															typeIdentifier: "t_bytes32",
															typeString: "bytes32"
														}
													},
													{
														argumentTypes: null,
														id: 1645,
														name: "tableKey",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 1591,
														src: "13120:8:2",
														typeDescriptions: {
															typeIdentifier: "t_bytes32",
															typeString: "bytes32"
														}
													},
													{
														argumentTypes: null,
														id: 1646,
														name: "idTableKey",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 1593,
														src: "13130:10:2",
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
													id: 1643,
													name: "isNamehashSubOf",
													nodeType: "Identifier",
													overloadedDeclarations: [
													],
													referencedDeclaration: 1880,
													src: "13097:15:2",
													typeDescriptions: {
														typeIdentifier: "t_function_internal_pure$_t_bytes32_$_t_bytes32_$_t_bytes32_$returns$_t_bool_$",
														typeString: "function (bytes32,bytes32,bytes32) pure returns (bool)"
													}
												},
												id: 1647,
												isConstant: false,
												isLValue: false,
												isPure: false,
												kind: "functionCall",
												lValueRequested: false,
												names: [
												],
												nodeType: "FunctionCall",
												src: "13097:44:2",
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
												id: 1648,
												isConstant: false,
												isLValue: false,
												isPure: true,
												kind: "bool",
												lValueRequested: false,
												nodeType: "Literal",
												src: "13145:4:2",
												subdenomination: null,
												typeDescriptions: {
													typeIdentifier: "t_bool",
													typeString: "bool"
												},
												value: "true"
											},
											src: "13097:52:2",
											typeDescriptions: {
												typeIdentifier: "t_bool",
												typeString: "bool"
											}
										},
										{
											argumentTypes: null,
											hexValue: "69645461626c654b6579206e6f7420612073756268617368205b69645d2e5b7461626c655d",
											id: 1650,
											isConstant: false,
											isLValue: false,
											isPure: true,
											kind: "string",
											lValueRequested: false,
											nodeType: "Literal",
											src: "13151:39:2",
											subdenomination: null,
											typeDescriptions: {
												typeIdentifier: "t_stringliteral_32e4c05ca8a5b34e37d3b74cb3500c0583d8bf5ba2edec98c710e79b95cc1e88",
												typeString: "literal_string \"idTableKey not a subhash [id].[table]\""
											},
											value: "idTableKey not a subhash [id].[table]"
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bool",
												typeString: "bool"
											},
											{
												typeIdentifier: "t_stringliteral_32e4c05ca8a5b34e37d3b74cb3500c0583d8bf5ba2edec98c710e79b95cc1e88",
												typeString: "literal_string \"idTableKey not a subhash [id].[table]\""
											}
										],
										id: 1642,
										name: "require",
										nodeType: "Identifier",
										overloadedDeclarations: [
											10931,
											10932
										],
										referencedDeclaration: 10932,
										src: "13089:7:2",
										typeDescriptions: {
											typeIdentifier: "t_function_require_pure$_t_bool_$_t_string_memory_ptr_$returns$__$",
											typeString: "function (bool,string memory) pure"
										}
									},
									id: 1651,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "13089:102:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 1652,
								nodeType: "ExpressionStatement",
								src: "13089:102:2"
							},
							{
								condition: {
									argumentTypes: null,
									commonType: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									},
									id: 1655,
									isConstant: false,
									isLValue: false,
									isPure: false,
									lValueRequested: false,
									leftExpression: {
										argumentTypes: null,
										id: 1653,
										name: "permission",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 1611,
										src: "13365:10:2",
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
										id: 1654,
										isConstant: false,
										isLValue: false,
										isPure: true,
										kind: "number",
										lValueRequested: false,
										nodeType: "Literal",
										src: "13379:1:2",
										subdenomination: null,
										typeDescriptions: {
											typeIdentifier: "t_rational_2_by_1",
											typeString: "int_const 2"
										},
										value: "2"
									},
									src: "13365:15:2",
									typeDescriptions: {
										typeIdentifier: "t_bool",
										typeString: "bool"
									}
								},
								falseBody: null,
								id: 1692,
								nodeType: "IfStatement",
								src: "13361:457:2",
								trueBody: {
									id: 1691,
									nodeType: "Block",
									src: "13382:436:2",
									statements: [
										{
											condition: {
												argumentTypes: null,
												commonType: {
													typeIdentifier: "t_bool",
													typeString: "bool"
												},
												id: 1662,
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
														id: 1656,
														name: "isOwner",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 4936,
														src: "13400:7:2",
														typeDescriptions: {
															typeIdentifier: "t_function_internal_view$__$returns$_t_bool_$",
															typeString: "function () view returns (bool)"
														}
													},
													id: 1657,
													isConstant: false,
													isLValue: false,
													isPure: false,
													kind: "functionCall",
													lValueRequested: false,
													names: [
													],
													nodeType: "FunctionCall",
													src: "13400:9:2",
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
													id: 1661,
													isConstant: false,
													isLValue: false,
													isPure: false,
													lValueRequested: false,
													leftExpression: {
														argumentTypes: null,
														id: 1658,
														name: "delegate",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 1613,
														src: "13413:8:2",
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
															id: 1659,
															name: "_msgSender",
															nodeType: "Identifier",
															overloadedDeclarations: [
																3527
															],
															referencedDeclaration: 3527,
															src: "13425:10:2",
															typeDescriptions: {
																typeIdentifier: "t_function_internal_view$__$returns$_t_address_$",
																typeString: "function () view returns (address)"
															}
														},
														id: 1660,
														isConstant: false,
														isLValue: false,
														isPure: false,
														kind: "functionCall",
														lValueRequested: false,
														names: [
														],
														nodeType: "FunctionCall",
														src: "13425:12:2",
														typeDescriptions: {
															typeIdentifier: "t_address",
															typeString: "address"
														}
													},
													src: "13413:24:2",
													typeDescriptions: {
														typeIdentifier: "t_bool",
														typeString: "bool"
													}
												},
												src: "13400:37:2",
												typeDescriptions: {
													typeIdentifier: "t_bool",
													typeString: "bool"
												}
											},
											falseBody: {
												id: 1689,
												nodeType: "Block",
												src: "13483:325:2",
												statements: [
													{
														assignments: [
															1665
														],
														declarations: [
															{
																constant: false,
																id: 1665,
																name: "rowMetaData",
																nodeType: "VariableDeclaration",
																scope: 1689,
																src: "13586:19:2",
																stateVariable: false,
																storageLocation: "default",
																typeDescriptions: {
																	typeIdentifier: "t_bytes32",
																	typeString: "bytes32"
																},
																typeName: {
																	id: 1664,
																	name: "bytes32",
																	nodeType: "ElementaryTypeName",
																	src: "13586:7:2",
																	typeDescriptions: {
																		typeIdentifier: "t_bytes32",
																		typeString: "bytes32"
																	}
																},
																value: null,
																visibility: "internal"
															}
														],
														id: 1670,
														initialValue: {
															argumentTypes: null,
															"arguments": [
																{
																	argumentTypes: null,
																	id: 1668,
																	name: "idTableKey",
																	nodeType: "Identifier",
																	overloadedDeclarations: [
																	],
																	referencedDeclaration: 1593,
																	src: "13634:10:2",
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
																	id: 1666,
																	name: "database",
																	nodeType: "Identifier",
																	overloadedDeclarations: [
																	],
																	referencedDeclaration: 997,
																	src: "13608:8:2",
																	typeDescriptions: {
																		typeIdentifier: "t_struct$_PolymorphicDictionary_$7410_storage",
																		typeString: "struct PolymorphicDictionaryLib.PolymorphicDictionary storage ref"
																	}
																},
																id: 1667,
																isConstant: false,
																isLValue: true,
																isPure: false,
																lValueRequested: false,
																memberName: "getBytes32ForKey",
																nodeType: "MemberAccess",
																referencedDeclaration: 7891,
																src: "13608:25:2",
																typeDescriptions: {
																	typeIdentifier: "t_function_internal_view$_t_struct$_PolymorphicDictionary_$7410_storage_ptr_$_t_bytes32_$returns$_t_bytes32_$bound_to$_t_struct$_PolymorphicDictionary_$7410_storage_ptr_$",
																	typeString: "function (struct PolymorphicDictionaryLib.PolymorphicDictionary storage pointer,bytes32) view returns (bytes32)"
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
															src: "13608:37:2",
															typeDescriptions: {
																typeIdentifier: "t_bytes32",
																typeString: "bytes32"
															}
														},
														nodeType: "VariableDeclarationStatement",
														src: "13586:59:2"
													},
													{
														assignments: [
															1672
														],
														declarations: [
															{
																constant: false,
																id: 1672,
																name: "rowOwner",
																nodeType: "VariableDeclaration",
																scope: 1689,
																src: "13663:16:2",
																stateVariable: false,
																storageLocation: "default",
																typeDescriptions: {
																	typeIdentifier: "t_address",
																	typeString: "address"
																},
																typeName: {
																	id: 1671,
																	name: "address",
																	nodeType: "ElementaryTypeName",
																	src: "13663:7:2",
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
														id: 1680,
														initialValue: {
															argumentTypes: null,
															"arguments": [
																{
																	argumentTypes: null,
																	commonType: {
																		typeIdentifier: "t_uint256",
																		typeString: "uint256"
																	},
																	id: 1678,
																	isConstant: false,
																	isLValue: false,
																	isPure: false,
																	lValueRequested: false,
																	leftExpression: {
																		argumentTypes: null,
																		"arguments": [
																			{
																				argumentTypes: null,
																				id: 1675,
																				name: "rowMetaData",
																				nodeType: "Identifier",
																				overloadedDeclarations: [
																				],
																				referencedDeclaration: 1665,
																				src: "13698:11:2",
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
																			id: 1674,
																			isConstant: false,
																			isLValue: false,
																			isPure: true,
																			lValueRequested: false,
																			nodeType: "ElementaryTypeNameExpression",
																			src: "13690:7:2",
																			typeDescriptions: {
																				typeIdentifier: "t_type$_t_uint256_$",
																				typeString: "type(uint256)"
																			},
																			typeName: "uint256"
																		},
																		id: 1676,
																		isConstant: false,
																		isLValue: false,
																		isPure: false,
																		kind: "typeConversion",
																		lValueRequested: false,
																		names: [
																		],
																		nodeType: "FunctionCall",
																		src: "13690:20:2",
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
																		id: 1677,
																		isConstant: false,
																		isLValue: false,
																		isPure: true,
																		kind: "number",
																		lValueRequested: false,
																		nodeType: "Literal",
																		src: "13712:2:2",
																		subdenomination: null,
																		typeDescriptions: {
																			typeIdentifier: "t_rational_32_by_1",
																			typeString: "int_const 32"
																		},
																		value: "32"
																	},
																	src: "13690:24:2",
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
																id: 1673,
																isConstant: false,
																isLValue: false,
																isPure: true,
																lValueRequested: false,
																nodeType: "ElementaryTypeNameExpression",
																src: "13682:7:2",
																typeDescriptions: {
																	typeIdentifier: "t_type$_t_address_$",
																	typeString: "type(address)"
																},
																typeName: "address"
															},
															id: 1679,
															isConstant: false,
															isLValue: false,
															isPure: false,
															kind: "typeConversion",
															lValueRequested: false,
															names: [
															],
															nodeType: "FunctionCall",
															src: "13682:33:2",
															typeDescriptions: {
																typeIdentifier: "t_address_payable",
																typeString: "address payable"
															}
														},
														nodeType: "VariableDeclarationStatement",
														src: "13663:52:2"
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
																	id: 1685,
																	isConstant: false,
																	isLValue: false,
																	isPure: false,
																	lValueRequested: false,
																	leftExpression: {
																		argumentTypes: null,
																		id: 1682,
																		name: "rowOwner",
																		nodeType: "Identifier",
																		overloadedDeclarations: [
																		],
																		referencedDeclaration: 1672,
																		src: "13741:8:2",
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
																			id: 1683,
																			name: "_msgSender",
																			nodeType: "Identifier",
																			overloadedDeclarations: [
																				3527
																			],
																			referencedDeclaration: 3527,
																			src: "13753:10:2",
																			typeDescriptions: {
																				typeIdentifier: "t_function_internal_view$__$returns$_t_address_$",
																				typeString: "function () view returns (address)"
																			}
																		},
																		id: 1684,
																		isConstant: false,
																		isLValue: false,
																		isPure: false,
																		kind: "functionCall",
																		lValueRequested: false,
																		names: [
																		],
																		nodeType: "FunctionCall",
																		src: "13753:12:2",
																		typeDescriptions: {
																			typeIdentifier: "t_address",
																			typeString: "address"
																		}
																	},
																	src: "13741:24:2",
																	typeDescriptions: {
																		typeIdentifier: "t_bool",
																		typeString: "bool"
																	}
																},
																{
																	argumentTypes: null,
																	hexValue: "53656e646572206e6f74206f776e6572206f6620726f77",
																	id: 1686,
																	isConstant: false,
																	isLValue: false,
																	isPure: true,
																	kind: "string",
																	lValueRequested: false,
																	nodeType: "Literal",
																	src: "13767:25:2",
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
																id: 1681,
																name: "require",
																nodeType: "Identifier",
																overloadedDeclarations: [
																	10931,
																	10932
																],
																referencedDeclaration: 10932,
																src: "13733:7:2",
																typeDescriptions: {
																	typeIdentifier: "t_function_require_pure$_t_bool_$_t_string_memory_ptr_$returns$__$",
																	typeString: "function (bool,string memory) pure"
																}
															},
															id: 1687,
															isConstant: false,
															isLValue: false,
															isPure: false,
															kind: "functionCall",
															lValueRequested: false,
															names: [
															],
															nodeType: "FunctionCall",
															src: "13733:60:2",
															typeDescriptions: {
																typeIdentifier: "t_tuple$__$",
																typeString: "tuple()"
															}
														},
														id: 1688,
														nodeType: "ExpressionStatement",
														src: "13733:60:2"
													}
												]
											},
											id: 1690,
											nodeType: "IfStatement",
											src: "13396:412:2",
											trueBody: {
												id: 1663,
												nodeType: "Block",
												src: "13438:39:2",
												statements: [
												]
											}
										}
									]
								}
							},
							{
								id: 1693,
								nodeType: "PlaceholderStatement",
								src: "13828:1:2"
							}
						]
					},
					documentation: null,
					id: 1695,
					name: "deleteCheck",
					nodeType: "ModifierDefinition",
					parameters: {
						id: 1598,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1591,
								name: "tableKey",
								nodeType: "VariableDeclaration",
								scope: 1695,
								src: "12441:16:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1590,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "12441:7:2",
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
								id: 1593,
								name: "idTableKey",
								nodeType: "VariableDeclaration",
								scope: 1695,
								src: "12459:18:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1592,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "12459:7:2",
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
								id: 1595,
								name: "idKey",
								nodeType: "VariableDeclaration",
								scope: 1695,
								src: "12479:13:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1594,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "12479:7:2",
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
								id: 1597,
								name: "id",
								nodeType: "VariableDeclaration",
								scope: 1695,
								src: "12494:10:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1596,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "12494:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "12440:65:2"
					},
					src: "12420:1416:2",
					visibility: "internal"
				},
				{
					body: {
						id: 1744,
						nodeType: "Block",
						src: "14241:1089:2",
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
											id: 1723,
											isConstant: false,
											isLValue: false,
											isPure: false,
											lValueRequested: false,
											leftExpression: {
												argumentTypes: null,
												"arguments": [
													{
														argumentTypes: null,
														id: 1718,
														name: "fieldKey",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 1705,
														src: "14351:8:2",
														typeDescriptions: {
															typeIdentifier: "t_bytes32",
															typeString: "bytes32"
														}
													},
													{
														argumentTypes: null,
														id: 1719,
														name: "idTableKey",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 1699,
														src: "14361:10:2",
														typeDescriptions: {
															typeIdentifier: "t_bytes32",
															typeString: "bytes32"
														}
													},
													{
														argumentTypes: null,
														id: 1720,
														name: "fieldIdTableKey",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 1707,
														src: "14373:15:2",
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
													id: 1717,
													name: "isNamehashSubOf",
													nodeType: "Identifier",
													overloadedDeclarations: [
													],
													referencedDeclaration: 1880,
													src: "14335:15:2",
													typeDescriptions: {
														typeIdentifier: "t_function_internal_pure$_t_bytes32_$_t_bytes32_$_t_bytes32_$returns$_t_bool_$",
														typeString: "function (bytes32,bytes32,bytes32) pure returns (bool)"
													}
												},
												id: 1721,
												isConstant: false,
												isLValue: false,
												isPure: false,
												kind: "functionCall",
												lValueRequested: false,
												names: [
												],
												nodeType: "FunctionCall",
												src: "14335:54:2",
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
												id: 1722,
												isConstant: false,
												isLValue: false,
												isPure: true,
												kind: "bool",
												lValueRequested: false,
												nodeType: "Literal",
												src: "14393:4:2",
												subdenomination: null,
												typeDescriptions: {
													typeIdentifier: "t_bool",
													typeString: "bool"
												},
												value: "true"
											},
											src: "14335:62:2",
											typeDescriptions: {
												typeIdentifier: "t_bool",
												typeString: "bool"
											}
										},
										{
											argumentTypes: null,
											hexValue: "6669656c644b6579206e6f7420612073756268617368205b6669656c645d2e5b69645d2e5b7461626c655d",
											id: 1724,
											isConstant: false,
											isLValue: false,
											isPure: true,
											kind: "string",
											lValueRequested: false,
											nodeType: "Literal",
											src: "14399:45:2",
											subdenomination: null,
											typeDescriptions: {
												typeIdentifier: "t_stringliteral_ffb24f5f0a8d53dbb9ae5d4e7b2c0f2217d28c61e321e2599160d24529f3bcc7",
												typeString: "literal_string \"fieldKey not a subhash [field].[id].[table]\""
											},
											value: "fieldKey not a subhash [field].[id].[table]"
										}
									],
									expression: {
										argumentTypes: [
											{
												typeIdentifier: "t_bool",
												typeString: "bool"
											},
											{
												typeIdentifier: "t_stringliteral_ffb24f5f0a8d53dbb9ae5d4e7b2c0f2217d28c61e321e2599160d24529f3bcc7",
												typeString: "literal_string \"fieldKey not a subhash [field].[id].[table]\""
											}
										],
										id: 1716,
										name: "require",
										nodeType: "Identifier",
										overloadedDeclarations: [
											10931,
											10932
										],
										referencedDeclaration: 10932,
										src: "14327:7:2",
										typeDescriptions: {
											typeIdentifier: "t_function_require_pure$_t_bool_$_t_string_memory_ptr_$returns$__$",
											typeString: "function (bool,string memory) pure"
										}
									},
									id: 1725,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "14327:118:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 1726,
								nodeType: "ExpressionStatement",
								src: "14327:118:2"
							},
							{
								expression: {
									argumentTypes: null,
									"arguments": [
									],
									expression: {
										argumentTypes: [
										],
										id: 1727,
										name: "increaseGsnCounter",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 2048,
										src: "14485:18:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_nonpayable$__$returns$__$",
											typeString: "function ()"
										}
									},
									id: 1728,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "14485:20:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 1729,
								nodeType: "ExpressionStatement",
								src: "14485:20:2"
							},
							{
								assignments: [
									1731
								],
								declarations: [
									{
										constant: false,
										id: 1731,
										name: "removed",
										nodeType: "VariableDeclaration",
										scope: 1744,
										src: "14542:12:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_bool",
											typeString: "bool"
										},
										typeName: {
											id: 1730,
											name: "bool",
											nodeType: "ElementaryTypeName",
											src: "14542:4:2",
											typeDescriptions: {
												typeIdentifier: "t_bool",
												typeString: "bool"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 1736,
								initialValue: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1734,
											name: "fieldIdTableKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1707,
											src: "14576:15:2",
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
											id: 1732,
											name: "database",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 997,
											src: "14557:8:2",
											typeDescriptions: {
												typeIdentifier: "t_struct$_PolymorphicDictionary_$7410_storage",
												typeString: "struct PolymorphicDictionaryLib.PolymorphicDictionary storage ref"
											}
										},
										id: 1733,
										isConstant: false,
										isLValue: true,
										isPure: false,
										lValueRequested: false,
										memberName: "removeKey",
										nodeType: "MemberAccess",
										referencedDeclaration: 8867,
										src: "14557:18:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_nonpayable$_t_struct$_PolymorphicDictionary_$7410_storage_ptr_$_t_bytes32_$returns$_t_bool_$bound_to$_t_struct$_PolymorphicDictionary_$7410_storage_ptr_$",
											typeString: "function (struct PolymorphicDictionaryLib.PolymorphicDictionary storage pointer,bytes32) returns (bool)"
										}
									},
									id: 1735,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "14557:35:2",
									typeDescriptions: {
										typeIdentifier: "t_bool",
										typeString: "bool"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "14542:50:2"
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
											id: 1740,
											isConstant: false,
											isLValue: false,
											isPure: false,
											lValueRequested: false,
											leftExpression: {
												argumentTypes: null,
												id: 1738,
												name: "removed",
												nodeType: "Identifier",
												overloadedDeclarations: [
												],
												referencedDeclaration: 1731,
												src: "14611:7:2",
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
												id: 1739,
												isConstant: false,
												isLValue: false,
												isPure: true,
												kind: "bool",
												lValueRequested: false,
												nodeType: "Literal",
												src: "14622:4:2",
												subdenomination: null,
												typeDescriptions: {
													typeIdentifier: "t_bool",
													typeString: "bool"
												},
												value: "true"
											},
											src: "14611:15:2",
											typeDescriptions: {
												typeIdentifier: "t_bool",
												typeString: "bool"
											}
										},
										{
											argumentTypes: null,
											hexValue: "6572726f722072656d6f76696e67206b6579",
											id: 1741,
											isConstant: false,
											isLValue: false,
											isPure: true,
											kind: "string",
											lValueRequested: false,
											nodeType: "Literal",
											src: "14628:20:2",
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
										id: 1737,
										name: "require",
										nodeType: "Identifier",
										overloadedDeclarations: [
											10931,
											10932
										],
										referencedDeclaration: 10932,
										src: "14603:7:2",
										typeDescriptions: {
											typeIdentifier: "t_function_require_pure$_t_bool_$_t_string_memory_ptr_$returns$__$",
											typeString: "function (bool,string memory) pure"
										}
									},
									id: 1742,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "14603:46:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 1743,
								nodeType: "ExpressionStatement",
								src: "14603:46:2"
							}
						]
					},
					documentation: "@dev TODO: add modifier checks based on update\n     * TODO: this needs to properly remove the row when there are multiple ids\n     ",
					id: 1745,
					implemented: true,
					kind: "function",
					modifiers: [
						{
							"arguments": [
								{
									argumentTypes: null,
									id: 1710,
									name: "tableKey",
									nodeType: "Identifier",
									overloadedDeclarations: [
									],
									referencedDeclaration: 1697,
									src: "14209:8:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								{
									argumentTypes: null,
									id: 1711,
									name: "idTableKey",
									nodeType: "Identifier",
									overloadedDeclarations: [
									],
									referencedDeclaration: 1699,
									src: "14219:10:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								{
									argumentTypes: null,
									id: 1712,
									name: "idKey",
									nodeType: "Identifier",
									overloadedDeclarations: [
									],
									referencedDeclaration: 1701,
									src: "14231:5:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								{
									argumentTypes: null,
									id: 1713,
									name: "id",
									nodeType: "Identifier",
									overloadedDeclarations: [
									],
									referencedDeclaration: 1703,
									src: "14238:2:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								}
							],
							id: 1714,
							modifierName: {
								argumentTypes: null,
								id: 1709,
								name: "deleteCheck",
								nodeType: "Identifier",
								overloadedDeclarations: [
								],
								referencedDeclaration: 1695,
								src: "14197:11:2",
								typeDescriptions: {
									typeIdentifier: "t_modifier$_t_bytes32_$_t_bytes32_$_t_bytes32_$_t_bytes32_$",
									typeString: "modifier (bytes32,bytes32,bytes32,bytes32)"
								}
							},
							nodeType: "ModifierInvocation",
							src: "14197:44:2"
						}
					],
					name: "deleteVal",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 1708,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1697,
								name: "tableKey",
								nodeType: "VariableDeclaration",
								scope: 1745,
								src: "14034:16:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1696,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "14034:7:2",
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
								id: 1699,
								name: "idTableKey",
								nodeType: "VariableDeclaration",
								scope: 1745,
								src: "14060:18:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1698,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "14060:7:2",
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
								id: 1701,
								name: "idKey",
								nodeType: "VariableDeclaration",
								scope: 1745,
								src: "14089:13:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1700,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "14089:7:2",
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
								id: 1703,
								name: "id",
								nodeType: "VariableDeclaration",
								scope: 1745,
								src: "14112:10:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1702,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "14112:7:2",
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
								id: 1705,
								name: "fieldKey",
								nodeType: "VariableDeclaration",
								scope: 1745,
								src: "14133:16:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1704,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "14133:7:2",
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
								id: 1707,
								name: "fieldIdTableKey",
								nodeType: "VariableDeclaration",
								scope: 1745,
								src: "14159:23:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1706,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "14159:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "14023:166:2"
					},
					returnParameters: {
						id: 1715,
						nodeType: "ParameterList",
						parameters: [
						],
						src: "14241:0:2"
					},
					scope: 2209,
					src: "14005:1325:2",
					stateMutability: "nonpayable",
					superFunction: null,
					visibility: "public"
				},
				{
					body: {
						id: 1772,
						nodeType: "Block",
						src: "15785:142:2",
						statements: [
							{
								expression: {
									argumentTypes: null,
									"arguments": [
									],
									expression: {
										argumentTypes: [
										],
										id: 1762,
										name: "increaseGsnCounter",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 2048,
										src: "15825:18:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_nonpayable$__$returns$__$",
											typeString: "function ()"
										}
									},
									id: 1763,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "15825:20:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 1764,
								nodeType: "ExpressionStatement",
								src: "15825:20:2"
							},
							{
								expression: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1768,
											name: "tableKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1747,
											src: "15907:8:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										{
											argumentTypes: null,
											id: 1769,
											name: "id",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1753,
											src: "15917:2:2",
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
											id: 1765,
											name: "tableId",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 986,
											src: "15881:7:2",
											typeDescriptions: {
												typeIdentifier: "t_struct$_Bytes32SetDictionary_$6170_storage",
												typeString: "struct Bytes32SetDictionaryLib.Bytes32SetDictionary storage ref"
											}
										},
										id: 1767,
										isConstant: false,
										isLValue: true,
										isPure: false,
										lValueRequested: false,
										memberName: "removeValueForKey",
										nodeType: "MemberAccess",
										referencedDeclaration: 6328,
										src: "15881:25:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_nonpayable$_t_struct$_Bytes32SetDictionary_$6170_storage_ptr_$_t_bytes32_$_t_bytes32_$returns$_t_bool_$bound_to$_t_struct$_Bytes32SetDictionary_$6170_storage_ptr_$",
											typeString: "function (struct Bytes32SetDictionaryLib.Bytes32SetDictionary storage pointer,bytes32,bytes32) returns (bool)"
										}
									},
									id: 1770,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "15881:39:2",
									typeDescriptions: {
										typeIdentifier: "t_bool",
										typeString: "bool"
									}
								},
								id: 1771,
								nodeType: "ExpressionStatement",
								src: "15881:39:2"
							}
						]
					},
					documentation: null,
					id: 1773,
					implemented: true,
					kind: "function",
					modifiers: [
						{
							"arguments": [
								{
									argumentTypes: null,
									id: 1756,
									name: "tableKey",
									nodeType: "Identifier",
									overloadedDeclarations: [
									],
									referencedDeclaration: 1747,
									src: "15753:8:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								{
									argumentTypes: null,
									id: 1757,
									name: "idTableKey",
									nodeType: "Identifier",
									overloadedDeclarations: [
									],
									referencedDeclaration: 1749,
									src: "15763:10:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								{
									argumentTypes: null,
									id: 1758,
									name: "idKey",
									nodeType: "Identifier",
									overloadedDeclarations: [
									],
									referencedDeclaration: 1751,
									src: "15775:5:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								{
									argumentTypes: null,
									id: 1759,
									name: "id",
									nodeType: "Identifier",
									overloadedDeclarations: [
									],
									referencedDeclaration: 1753,
									src: "15782:2:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								}
							],
							id: 1760,
							modifierName: {
								argumentTypes: null,
								id: 1755,
								name: "deleteCheck",
								nodeType: "Identifier",
								overloadedDeclarations: [
								],
								referencedDeclaration: 1695,
								src: "15741:11:2",
								typeDescriptions: {
									typeIdentifier: "t_modifier$_t_bytes32_$_t_bytes32_$_t_bytes32_$_t_bytes32_$",
									typeString: "modifier (bytes32,bytes32,bytes32,bytes32)"
								}
							},
							nodeType: "ModifierInvocation",
							src: "15741:44:2"
						}
					],
					name: "deleteRow",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 1754,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1747,
								name: "tableKey",
								nodeType: "VariableDeclaration",
								scope: 1773,
								src: "15638:16:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1746,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "15638:7:2",
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
								id: 1749,
								name: "idTableKey",
								nodeType: "VariableDeclaration",
								scope: 1773,
								src: "15664:18:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1748,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "15664:7:2",
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
								id: 1751,
								name: "idKey",
								nodeType: "VariableDeclaration",
								scope: 1773,
								src: "15693:13:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1750,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "15693:7:2",
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
								id: 1753,
								name: "id",
								nodeType: "VariableDeclaration",
								scope: 1773,
								src: "15716:10:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1752,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "15716:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "15627:106:2"
					},
					returnParameters: {
						id: 1761,
						nodeType: "ParameterList",
						parameters: [
						],
						src: "15785:0:2"
					},
					scope: 2209,
					src: "15609:318:2",
					stateMutability: "nonpayable",
					superFunction: null,
					visibility: "public"
				},
				{
					body: {
						id: 1785,
						nodeType: "Block",
						src: "17316:49:2",
						statements: [
							{
								expression: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1782,
											name: "key",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1775,
											src: "17354:3:2",
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
											id: 1780,
											name: "database",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 997,
											src: "17333:8:2",
											typeDescriptions: {
												typeIdentifier: "t_struct$_PolymorphicDictionary_$7410_storage",
												typeString: "struct PolymorphicDictionaryLib.PolymorphicDictionary storage ref"
											}
										},
										id: 1781,
										isConstant: false,
										isLValue: true,
										isPure: false,
										lValueRequested: false,
										memberName: "containsKey",
										nodeType: "MemberAccess",
										referencedDeclaration: 7718,
										src: "17333:20:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_view$_t_struct$_PolymorphicDictionary_$7410_storage_ptr_$_t_bytes32_$returns$_t_bool_$bound_to$_t_struct$_PolymorphicDictionary_$7410_storage_ptr_$",
											typeString: "function (struct PolymorphicDictionaryLib.PolymorphicDictionary storage pointer,bytes32) view returns (bool)"
										}
									},
									id: 1783,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "17333:25:2",
									typeDescriptions: {
										typeIdentifier: "t_bool",
										typeString: "bool"
									}
								},
								functionReturnParameters: 1779,
								id: 1784,
								nodeType: "Return",
								src: "17326:32:2"
							}
						]
					},
					documentation: "@dev Table actual insert call, NOTE this doesn't work on testnet currently due to a stack size issue,\n     but it can work with a paid transaction I guess",
					id: 1786,
					implemented: true,
					kind: "function",
					modifiers: [
					],
					name: "checkDataKey",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 1776,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1775,
								name: "key",
								nodeType: "VariableDeclaration",
								scope: 1786,
								src: "17274:11:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1774,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "17274:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "17273:13:2"
					},
					returnParameters: {
						id: 1779,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1778,
								name: "",
								nodeType: "VariableDeclaration",
								scope: 1786,
								src: "17310:4:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bool",
									typeString: "bool"
								},
								typeName: {
									id: 1777,
									name: "bool",
									nodeType: "ElementaryTypeName",
									src: "17310:4:2",
									typeDescriptions: {
										typeIdentifier: "t_bool",
										typeString: "bool"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "17309:6:2"
					},
					scope: 2209,
					src: "17252:113:2",
					stateMutability: "view",
					superFunction: null,
					visibility: "external"
				},
				{
					body: {
						id: 1809,
						nodeType: "Block",
						src: "17575:182:2",
						statements: [
							{
								condition: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1795,
											name: "fieldIdTableKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1788,
											src: "17611:15:2",
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
											id: 1793,
											name: "database",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 997,
											src: "17590:8:2",
											typeDescriptions: {
												typeIdentifier: "t_struct$_PolymorphicDictionary_$7410_storage",
												typeString: "struct PolymorphicDictionaryLib.PolymorphicDictionary storage ref"
											}
										},
										id: 1794,
										isConstant: false,
										isLValue: true,
										isPure: false,
										lValueRequested: false,
										memberName: "containsKey",
										nodeType: "MemberAccess",
										referencedDeclaration: 7718,
										src: "17590:20:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_view$_t_struct$_PolymorphicDictionary_$7410_storage_ptr_$_t_bytes32_$returns$_t_bool_$bound_to$_t_struct$_PolymorphicDictionary_$7410_storage_ptr_$",
											typeString: "function (struct PolymorphicDictionaryLib.PolymorphicDictionary storage pointer,bytes32) view returns (bool)"
										}
									},
									id: 1796,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "17590:37:2",
									typeDescriptions: {
										typeIdentifier: "t_bool",
										typeString: "bool"
									}
								},
								falseBody: {
									id: 1807,
									nodeType: "Block",
									src: "17709:42:2",
									statements: [
										{
											expression: {
												argumentTypes: null,
												"arguments": [
													{
														argumentTypes: null,
														hexValue: "30",
														id: 1804,
														isConstant: false,
														isLValue: false,
														isPure: true,
														kind: "number",
														lValueRequested: false,
														nodeType: "Literal",
														src: "17738:1:2",
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
													id: 1803,
													isConstant: false,
													isLValue: false,
													isPure: true,
													lValueRequested: false,
													nodeType: "ElementaryTypeNameExpression",
													src: "17730:7:2",
													typeDescriptions: {
														typeIdentifier: "t_type$_t_bytes32_$",
														typeString: "type(bytes32)"
													},
													typeName: "bytes32"
												},
												id: 1805,
												isConstant: false,
												isLValue: false,
												isPure: true,
												kind: "typeConversion",
												lValueRequested: false,
												names: [
												],
												nodeType: "FunctionCall",
												src: "17730:10:2",
												typeDescriptions: {
													typeIdentifier: "t_bytes32",
													typeString: "bytes32"
												}
											},
											functionReturnParameters: 1792,
											id: 1806,
											nodeType: "Return",
											src: "17723:17:2"
										}
									]
								},
								id: 1808,
								nodeType: "IfStatement",
								src: "17586:165:2",
								trueBody: {
									id: 1802,
									nodeType: "Block",
									src: "17629:74:2",
									statements: [
										{
											expression: {
												argumentTypes: null,
												"arguments": [
													{
														argumentTypes: null,
														id: 1799,
														name: "fieldIdTableKey",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 1788,
														src: "17676:15:2",
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
														id: 1797,
														name: "database",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 997,
														src: "17650:8:2",
														typeDescriptions: {
															typeIdentifier: "t_struct$_PolymorphicDictionary_$7410_storage",
															typeString: "struct PolymorphicDictionaryLib.PolymorphicDictionary storage ref"
														}
													},
													id: 1798,
													isConstant: false,
													isLValue: true,
													isPure: false,
													lValueRequested: false,
													memberName: "getBytes32ForKey",
													nodeType: "MemberAccess",
													referencedDeclaration: 7891,
													src: "17650:25:2",
													typeDescriptions: {
														typeIdentifier: "t_function_internal_view$_t_struct$_PolymorphicDictionary_$7410_storage_ptr_$_t_bytes32_$returns$_t_bytes32_$bound_to$_t_struct$_PolymorphicDictionary_$7410_storage_ptr_$",
														typeString: "function (struct PolymorphicDictionaryLib.PolymorphicDictionary storage pointer,bytes32) view returns (bytes32)"
													}
												},
												id: 1800,
												isConstant: false,
												isLValue: false,
												isPure: false,
												kind: "functionCall",
												lValueRequested: false,
												names: [
												],
												nodeType: "FunctionCall",
												src: "17650:42:2",
												typeDescriptions: {
													typeIdentifier: "t_bytes32",
													typeString: "bytes32"
												}
											},
											functionReturnParameters: 1792,
											id: 1801,
											nodeType: "Return",
											src: "17643:49:2"
										}
									]
								}
							}
						]
					},
					documentation: "@dev all data is public, so no need for security checks, we leave the data type handling to the client",
					id: 1810,
					implemented: true,
					kind: "function",
					modifiers: [
					],
					name: "getRowValue",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 1789,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1788,
								name: "fieldIdTableKey",
								nodeType: "VariableDeclaration",
								scope: 1810,
								src: "17518:23:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1787,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "17518:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "17517:25:2"
					},
					returnParameters: {
						id: 1792,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1791,
								name: "",
								nodeType: "VariableDeclaration",
								scope: 1810,
								src: "17566:7:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1790,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "17566:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "17565:9:2"
					},
					scope: 2209,
					src: "17497:260:2",
					stateMutability: "view",
					superFunction: null,
					visibility: "external"
				},
				{
					body: {
						id: 1833,
						nodeType: "Block",
						src: "18333:136:2",
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
											id: 1824,
											isConstant: false,
											isLValue: false,
											isPure: false,
											lValueRequested: false,
											leftExpression: {
												argumentTypes: null,
												"arguments": [
													{
														argumentTypes: null,
														id: 1821,
														name: "tableKey",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 1812,
														src: "18372:8:2",
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
														id: 1819,
														name: "tableId",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 986,
														src: "18352:7:2",
														typeDescriptions: {
															typeIdentifier: "t_struct$_Bytes32SetDictionary_$6170_storage",
															typeString: "struct Bytes32SetDictionaryLib.Bytes32SetDictionary storage ref"
														}
													},
													id: 1820,
													isConstant: false,
													isLValue: true,
													isPure: false,
													lValueRequested: false,
													memberName: "containsKey",
													nodeType: "MemberAccess",
													referencedDeclaration: 6202,
													src: "18352:19:2",
													typeDescriptions: {
														typeIdentifier: "t_function_internal_view$_t_struct$_Bytes32SetDictionary_$6170_storage_ptr_$_t_bytes32_$returns$_t_bool_$bound_to$_t_struct$_Bytes32SetDictionary_$6170_storage_ptr_$",
														typeString: "function (struct Bytes32SetDictionaryLib.Bytes32SetDictionary storage pointer,bytes32) view returns (bool)"
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
												src: "18352:29:2",
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
												id: 1823,
												isConstant: false,
												isLValue: false,
												isPure: true,
												kind: "bool",
												lValueRequested: false,
												nodeType: "Literal",
												src: "18385:4:2",
												subdenomination: null,
												typeDescriptions: {
													typeIdentifier: "t_bool",
													typeString: "bool"
												},
												value: "true"
											},
											src: "18352:37:2",
											typeDescriptions: {
												typeIdentifier: "t_bool",
												typeString: "bool"
											}
										},
										{
											argumentTypes: null,
											hexValue: "7461626c65206e6f742063726561746564",
											id: 1825,
											isConstant: false,
											isLValue: false,
											isPure: true,
											kind: "string",
											lValueRequested: false,
											nodeType: "Literal",
											src: "18391:19:2",
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
										id: 1818,
										name: "require",
										nodeType: "Identifier",
										overloadedDeclarations: [
											10931,
											10932
										],
										referencedDeclaration: 10932,
										src: "18344:7:2",
										typeDescriptions: {
											typeIdentifier: "t_function_require_pure$_t_bool_$_t_string_memory_ptr_$returns$__$",
											typeString: "function (bool,string memory) pure"
										}
									},
									id: 1826,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "18344:67:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 1827,
								nodeType: "ExpressionStatement",
								src: "18344:67:2"
							},
							{
								expression: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1830,
											name: "tableKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1812,
											src: "18453:8:2",
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
											id: 1828,
											name: "tableId",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 986,
											src: "18429:7:2",
											typeDescriptions: {
												typeIdentifier: "t_struct$_Bytes32SetDictionary_$6170_storage",
												typeString: "struct Bytes32SetDictionaryLib.Bytes32SetDictionary storage ref"
											}
										},
										id: 1829,
										isConstant: false,
										isLValue: true,
										isPure: false,
										lValueRequested: false,
										memberName: "enumerateForKey",
										nodeType: "MemberAccess",
										referencedDeclaration: 6411,
										src: "18429:23:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_view$_t_struct$_Bytes32SetDictionary_$6170_storage_ptr_$_t_bytes32_$returns$_t_array$_t_bytes32_$dyn_memory_ptr_$bound_to$_t_struct$_Bytes32SetDictionary_$6170_storage_ptr_$",
											typeString: "function (struct Bytes32SetDictionaryLib.Bytes32SetDictionary storage pointer,bytes32) view returns (bytes32[] memory)"
										}
									},
									id: 1831,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "18429:33:2",
									typeDescriptions: {
										typeIdentifier: "t_array$_t_bytes32_$dyn_memory_ptr",
										typeString: "bytes32[] memory"
									}
								},
								functionReturnParameters: 1817,
								id: 1832,
								nodeType: "Return",
								src: "18422:40:2"
							}
						]
					},
					documentation: "@dev Warning this produces an Error: overflow (operation=\"setValue\", fault=\"overflow\", details=\"Number can only safely store up to 53 bits\")\n     if the table doesn't exist",
					id: 1834,
					implemented: true,
					kind: "function",
					modifiers: [
					],
					name: "getTableIds",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 1813,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1812,
								name: "tableKey",
								nodeType: "VariableDeclaration",
								scope: 1834,
								src: "18275:16:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1811,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "18275:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "18274:18:2"
					},
					returnParameters: {
						id: 1817,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1816,
								name: "",
								nodeType: "VariableDeclaration",
								scope: 1834,
								src: "18316:16:2",
								stateVariable: false,
								storageLocation: "memory",
								typeDescriptions: {
									typeIdentifier: "t_array$_t_bytes32_$dyn_memory_ptr",
									typeString: "bytes32[]"
								},
								typeName: {
									baseType: {
										id: 1814,
										name: "bytes32",
										nodeType: "ElementaryTypeName",
										src: "18316:7:2",
										typeDescriptions: {
											typeIdentifier: "t_bytes32",
											typeString: "bytes32"
										}
									},
									id: 1815,
									length: null,
									nodeType: "ArrayTypeName",
									src: "18316:9:2",
									typeDescriptions: {
										typeIdentifier: "t_array$_t_bytes32_$dyn_storage_ptr",
										typeString: "bytes32[]"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "18315:18:2"
					},
					scope: 2209,
					src: "18254:215:2",
					stateMutability: "view",
					superFunction: null,
					visibility: "external"
				},
				{
					body: {
						id: 1849,
						nodeType: "Block",
						src: "18555:65:2",
						statements: [
							{
								expression: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1845,
											name: "tableKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1836,
											src: "18600:8:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										{
											argumentTypes: null,
											id: 1846,
											name: "id",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1838,
											src: "18610:2:2",
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
											id: 1843,
											name: "tableId",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 986,
											src: "18572:7:2",
											typeDescriptions: {
												typeIdentifier: "t_struct$_Bytes32SetDictionary_$6170_storage",
												typeString: "struct Bytes32SetDictionaryLib.Bytes32SetDictionary storage ref"
											}
										},
										id: 1844,
										isConstant: false,
										isLValue: true,
										isPure: false,
										lValueRequested: false,
										memberName: "containsValueForKey",
										nodeType: "MemberAccess",
										referencedDeclaration: 6357,
										src: "18572:27:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_view$_t_struct$_Bytes32SetDictionary_$6170_storage_ptr_$_t_bytes32_$_t_bytes32_$returns$_t_bool_$bound_to$_t_struct$_Bytes32SetDictionary_$6170_storage_ptr_$",
											typeString: "function (struct Bytes32SetDictionaryLib.Bytes32SetDictionary storage pointer,bytes32,bytes32) view returns (bool)"
										}
									},
									id: 1847,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "18572:41:2",
									typeDescriptions: {
										typeIdentifier: "t_bool",
										typeString: "bool"
									}
								},
								functionReturnParameters: 1842,
								id: 1848,
								nodeType: "Return",
								src: "18565:48:2"
							}
						]
					},
					documentation: null,
					id: 1850,
					implemented: true,
					kind: "function",
					modifiers: [
					],
					name: "getIdExists",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 1839,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1836,
								name: "tableKey",
								nodeType: "VariableDeclaration",
								scope: 1850,
								src: "18496:16:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1835,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "18496:7:2",
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
								id: 1838,
								name: "id",
								nodeType: "VariableDeclaration",
								scope: 1850,
								src: "18514:10:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1837,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "18514:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "18495:30:2"
					},
					returnParameters: {
						id: 1842,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1841,
								name: "",
								nodeType: "VariableDeclaration",
								scope: 1850,
								src: "18549:4:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bool",
									typeString: "bool"
								},
								typeName: {
									id: 1840,
									name: "bool",
									nodeType: "ElementaryTypeName",
									src: "18549:4:2",
									typeDescriptions: {
										typeIdentifier: "t_bool",
										typeString: "bool"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "18548:6:2"
					},
					scope: 2209,
					src: "18475:145:2",
					stateMutability: "view",
					superFunction: null,
					visibility: "external"
				},
				{
					body: {
						id: 1879,
						nodeType: "Block",
						src: "18726:248:2",
						statements: [
							{
								assignments: [
									1862
								],
								declarations: [
									{
										constant: false,
										id: 1862,
										name: "concat",
										nodeType: "VariableDeclaration",
										scope: 1879,
										src: "18737:19:2",
										stateVariable: false,
										storageLocation: "memory",
										typeDescriptions: {
											typeIdentifier: "t_bytes_memory_ptr",
											typeString: "bytes"
										},
										typeName: {
											id: 1861,
											name: "bytes",
											nodeType: "ElementaryTypeName",
											src: "18737:5:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes_storage_ptr",
												typeString: "bytes"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 1867,
								initialValue: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											hexValue: "3634",
											id: 1865,
											isConstant: false,
											isLValue: false,
											isPure: true,
											kind: "number",
											lValueRequested: false,
											nodeType: "Literal",
											src: "18769:2:2",
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
										id: 1864,
										isConstant: false,
										isLValue: false,
										isPure: true,
										lValueRequested: false,
										nodeType: "NewExpression",
										src: "18759:9:2",
										typeDescriptions: {
											typeIdentifier: "t_function_objectcreation_pure$_t_uint256_$returns$_t_bytes_memory_$",
											typeString: "function (uint256) pure returns (bytes memory)"
										},
										typeName: {
											id: 1863,
											name: "bytes",
											nodeType: "ElementaryTypeName",
											src: "18763:5:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes_storage_ptr",
												typeString: "bytes"
											}
										}
									},
									id: 1866,
									isConstant: false,
									isLValue: false,
									isPure: true,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "18759:13:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes_memory",
										typeString: "bytes memory"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "18737:35:2"
							},
							{
								externalReferences: [
									{
										subKey: {
											declaration: 1852,
											isOffset: false,
											isSlot: false,
											src: "18830:6:2",
											valueSize: 1
										}
									},
									{
										concat: {
											declaration: 1862,
											isOffset: false,
											isSlot: false,
											src: "18817:6:2",
											valueSize: 1
										}
									},
									{
										base: {
											declaration: 1854,
											isOffset: false,
											isSlot: false,
											src: "18874:4:2",
											valueSize: 1
										}
									},
									{
										concat: {
											declaration: 1862,
											isOffset: false,
											isSlot: false,
											src: "18861:6:2",
											valueSize: 1
										}
									}
								],
								id: 1868,
								nodeType: "InlineAssembly",
								operations: "{\n    mstore(add(concat, 64), subKey)\n    mstore(add(concat, 32), base)\n}",
								src: "18783:123:2"
							},
							{
								assignments: [
									1870
								],
								declarations: [
									{
										constant: false,
										id: 1870,
										name: "result",
										nodeType: "VariableDeclaration",
										scope: 1879,
										src: "18899:14:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_bytes32",
											typeString: "bytes32"
										},
										typeName: {
											id: 1869,
											name: "bytes32",
											nodeType: "ElementaryTypeName",
											src: "18899:7:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 1874,
								initialValue: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 1872,
											name: "concat",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1862,
											src: "18926:6:2",
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
										id: 1871,
										name: "keccak256",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 10922,
										src: "18916:9:2",
										typeDescriptions: {
											typeIdentifier: "t_function_keccak256_pure$_t_bytes_memory_ptr_$returns$_t_bytes32_$",
											typeString: "function (bytes memory) pure returns (bytes32)"
										}
									},
									id: 1873,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "18916:17:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "18899:34:2"
							},
							{
								expression: {
									argumentTypes: null,
									commonType: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									},
									id: 1877,
									isConstant: false,
									isLValue: false,
									isPure: false,
									lValueRequested: false,
									leftExpression: {
										argumentTypes: null,
										id: 1875,
										name: "result",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 1870,
										src: "18951:6:2",
										typeDescriptions: {
											typeIdentifier: "t_bytes32",
											typeString: "bytes32"
										}
									},
									nodeType: "BinaryOperation",
									operator: "==",
									rightExpression: {
										argumentTypes: null,
										id: 1876,
										name: "target",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 1856,
										src: "18961:6:2",
										typeDescriptions: {
											typeIdentifier: "t_bytes32",
											typeString: "bytes32"
										}
									},
									src: "18951:16:2",
									typeDescriptions: {
										typeIdentifier: "t_bool",
										typeString: "bool"
									}
								},
								functionReturnParameters: 1860,
								id: 1878,
								nodeType: "Return",
								src: "18944:23:2"
							}
						]
					},
					documentation: null,
					id: 1880,
					implemented: true,
					kind: "function",
					modifiers: [
					],
					name: "isNamehashSubOf",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 1857,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1852,
								name: "subKey",
								nodeType: "VariableDeclaration",
								scope: 1880,
								src: "18651:14:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1851,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "18651:7:2",
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
								id: 1854,
								name: "base",
								nodeType: "VariableDeclaration",
								scope: 1880,
								src: "18667:12:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1853,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "18667:7:2",
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
								id: 1856,
								name: "target",
								nodeType: "VariableDeclaration",
								scope: 1880,
								src: "18681:14:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1855,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "18681:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "18650:46:2"
					},
					returnParameters: {
						id: 1860,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1859,
								name: "",
								nodeType: "VariableDeclaration",
								scope: 1880,
								src: "18720:4:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bool",
									typeString: "bool"
								},
								typeName: {
									id: 1858,
									name: "bool",
									nodeType: "ElementaryTypeName",
									src: "18720:4:2",
									typeDescriptions: {
										typeIdentifier: "t_bool",
										typeString: "bool"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "18719:6:2"
					},
					scope: 2209,
					src: "18626:348:2",
					stateMutability: "pure",
					superFunction: null,
					visibility: "internal"
				},
				{
					body: {
						id: 1922,
						nodeType: "Block",
						src: "19212:231:2",
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
											id: 1894,
											isConstant: false,
											isLValue: false,
											isPure: false,
											lValueRequested: false,
											leftExpression: {
												argumentTypes: null,
												baseExpression: {
													argumentTypes: null,
													id: 1890,
													name: "_table",
													nodeType: "Identifier",
													overloadedDeclarations: [
													],
													referencedDeclaration: 984,
													src: "19230:6:2",
													typeDescriptions: {
														typeIdentifier: "t_mapping$_t_bytes32_$_t_bytes32_$",
														typeString: "mapping(bytes32 => bytes32)"
													}
												},
												id: 1892,
												indexExpression: {
													argumentTypes: null,
													id: 1891,
													name: "_tableKey",
													nodeType: "Identifier",
													overloadedDeclarations: [
													],
													referencedDeclaration: 1882,
													src: "19237:9:2",
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
												src: "19230:17:2",
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
												id: 1893,
												isConstant: false,
												isLValue: false,
												isPure: true,
												kind: "number",
												lValueRequested: false,
												nodeType: "Literal",
												src: "19250:1:2",
												subdenomination: null,
												typeDescriptions: {
													typeIdentifier: "t_rational_0_by_1",
													typeString: "int_const 0"
												},
												value: "0"
											},
											src: "19230:21:2",
											typeDescriptions: {
												typeIdentifier: "t_bool",
												typeString: "bool"
											}
										},
										{
											argumentTypes: null,
											hexValue: "7461626c6520646f6573206e6f74206578697374",
											id: 1895,
											isConstant: false,
											isLValue: false,
											isPure: true,
											kind: "string",
											lValueRequested: false,
											nodeType: "Literal",
											src: "19253:22:2",
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
										id: 1889,
										name: "require",
										nodeType: "Identifier",
										overloadedDeclarations: [
											10931,
											10932
										],
										referencedDeclaration: 10932,
										src: "19222:7:2",
										typeDescriptions: {
											typeIdentifier: "t_function_require_pure$_t_bool_$_t_string_memory_ptr_$returns$__$",
											typeString: "function (bool,string memory) pure"
										}
									},
									id: 1896,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "19222:54:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 1897,
								nodeType: "ExpressionStatement",
								src: "19222:54:2"
							},
							{
								assignments: [
									1899
								],
								declarations: [
									{
										constant: false,
										id: 1899,
										name: "tableMetadata",
										nodeType: "VariableDeclaration",
										scope: 1922,
										src: "19287:21:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										},
										typeName: {
											id: 1898,
											name: "uint256",
											nodeType: "ElementaryTypeName",
											src: "19287:7:2",
											typeDescriptions: {
												typeIdentifier: "t_uint256",
												typeString: "uint256"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 1905,
								initialValue: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											baseExpression: {
												argumentTypes: null,
												id: 1901,
												name: "_table",
												nodeType: "Identifier",
												overloadedDeclarations: [
												],
												referencedDeclaration: 984,
												src: "19319:6:2",
												typeDescriptions: {
													typeIdentifier: "t_mapping$_t_bytes32_$_t_bytes32_$",
													typeString: "mapping(bytes32 => bytes32)"
												}
											},
											id: 1903,
											indexExpression: {
												argumentTypes: null,
												id: 1902,
												name: "_tableKey",
												nodeType: "Identifier",
												overloadedDeclarations: [
												],
												referencedDeclaration: 1882,
												src: "19326:9:2",
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
											src: "19319:17:2",
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
										id: 1900,
										isConstant: false,
										isLValue: false,
										isPure: true,
										lValueRequested: false,
										nodeType: "ElementaryTypeNameExpression",
										src: "19311:7:2",
										typeDescriptions: {
											typeIdentifier: "t_type$_t_uint256_$",
											typeString: "type(uint256)"
										},
										typeName: "uint256"
									},
									id: 1904,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "typeConversion",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "19311:26:2",
									typeDescriptions: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "19287:50:2"
							},
							{
								expression: {
									argumentTypes: null,
									id: 1912,
									isConstant: false,
									isLValue: false,
									isPure: false,
									lValueRequested: false,
									leftHandSide: {
										argumentTypes: null,
										id: 1906,
										name: "permission",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 1885,
										src: "19348:10:2",
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
														id: 1909,
														name: "tableMetadata",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 1899,
														src: "19375:13:2",
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
													id: 1908,
													isConstant: false,
													isLValue: false,
													isPure: true,
													lValueRequested: false,
													nodeType: "ElementaryTypeNameExpression",
													src: "19369:5:2",
													typeDescriptions: {
														typeIdentifier: "t_type$_t_uint8_$",
														typeString: "type(uint8)"
													},
													typeName: "uint8"
												},
												id: 1910,
												isConstant: false,
												isLValue: false,
												isPure: false,
												kind: "typeConversion",
												lValueRequested: false,
												names: [
												],
												nodeType: "FunctionCall",
												src: "19369:20:2",
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
											id: 1907,
											isConstant: false,
											isLValue: false,
											isPure: true,
											lValueRequested: false,
											nodeType: "ElementaryTypeNameExpression",
											src: "19361:7:2",
											typeDescriptions: {
												typeIdentifier: "t_type$_t_uint256_$",
												typeString: "type(uint256)"
											},
											typeName: "uint256"
										},
										id: 1911,
										isConstant: false,
										isLValue: false,
										isPure: false,
										kind: "typeConversion",
										lValueRequested: false,
										names: [
										],
										nodeType: "FunctionCall",
										src: "19361:29:2",
										typeDescriptions: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										}
									},
									src: "19348:42:2",
									typeDescriptions: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									}
								},
								id: 1913,
								nodeType: "ExpressionStatement",
								src: "19348:42:2"
							},
							{
								expression: {
									argumentTypes: null,
									id: 1920,
									isConstant: false,
									isLValue: false,
									isPure: false,
									lValueRequested: false,
									leftHandSide: {
										argumentTypes: null,
										id: 1914,
										name: "delegate",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 1887,
										src: "19400:8:2",
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
												id: 1918,
												isConstant: false,
												isLValue: false,
												isPure: false,
												lValueRequested: false,
												leftExpression: {
													argumentTypes: null,
													id: 1916,
													name: "tableMetadata",
													nodeType: "Identifier",
													overloadedDeclarations: [
													],
													referencedDeclaration: 1899,
													src: "19419:13:2",
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
													id: 1917,
													isConstant: false,
													isLValue: false,
													isPure: true,
													kind: "number",
													lValueRequested: false,
													nodeType: "Literal",
													src: "19434:1:2",
													subdenomination: null,
													typeDescriptions: {
														typeIdentifier: "t_rational_8_by_1",
														typeString: "int_const 8"
													},
													value: "8"
												},
												src: "19419:16:2",
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
											id: 1915,
											isConstant: false,
											isLValue: false,
											isPure: true,
											lValueRequested: false,
											nodeType: "ElementaryTypeNameExpression",
											src: "19411:7:2",
											typeDescriptions: {
												typeIdentifier: "t_type$_t_address_$",
												typeString: "type(address)"
											},
											typeName: "address"
										},
										id: 1919,
										isConstant: false,
										isLValue: false,
										isPure: false,
										kind: "typeConversion",
										lValueRequested: false,
										names: [
										],
										nodeType: "FunctionCall",
										src: "19411:25:2",
										typeDescriptions: {
											typeIdentifier: "t_address_payable",
											typeString: "address payable"
										}
									},
									src: "19400:36:2",
									typeDescriptions: {
										typeIdentifier: "t_address",
										typeString: "address"
									}
								},
								id: 1921,
								nodeType: "ExpressionStatement",
								src: "19400:36:2"
							}
						]
					},
					documentation: null,
					id: 1923,
					implemented: true,
					kind: "function",
					modifiers: [
					],
					name: "getTableMetadata",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 1883,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1882,
								name: "_tableKey",
								nodeType: "VariableDeclaration",
								scope: 1923,
								src: "19106:17:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1881,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "19106:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "19105:19:2"
					},
					returnParameters: {
						id: 1888,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1885,
								name: "permission",
								nodeType: "VariableDeclaration",
								scope: 1923,
								src: "19170:18:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_uint256",
									typeString: "uint256"
								},
								typeName: {
									id: 1884,
									name: "uint256",
									nodeType: "ElementaryTypeName",
									src: "19170:7:2",
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
								id: 1887,
								name: "delegate",
								nodeType: "VariableDeclaration",
								scope: 1923,
								src: "19190:16:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_address",
									typeString: "address"
								},
								typeName: {
									id: 1886,
									name: "address",
									nodeType: "ElementaryTypeName",
									src: "19190:7:2",
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
						src: "19169:38:2"
					},
					scope: 2209,
					src: "19080:363:2",
					stateMutability: "view",
					superFunction: null,
					visibility: "public"
				},
				{
					body: {
						id: 1957,
						nodeType: "Block",
						src: "19548:176:2",
						statements: [
							{
								assignments: [
									1935
								],
								declarations: [
									{
										constant: false,
										id: 1935,
										name: "tableMetadata",
										nodeType: "VariableDeclaration",
										scope: 1957,
										src: "19558:21:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										},
										typeName: {
											id: 1934,
											name: "uint256",
											nodeType: "ElementaryTypeName",
											src: "19558:7:2",
											typeDescriptions: {
												typeIdentifier: "t_uint256",
												typeString: "uint256"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 1936,
								initialValue: null,
								nodeType: "VariableDeclarationStatement",
								src: "19558:21:2"
							},
							{
								expression: {
									argumentTypes: null,
									id: 1939,
									isConstant: false,
									isLValue: false,
									isPure: false,
									lValueRequested: false,
									leftHandSide: {
										argumentTypes: null,
										id: 1937,
										name: "tableMetadata",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 1935,
										src: "19590:13:2",
										typeDescriptions: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										}
									},
									nodeType: "Assignment",
									operator: "|=",
									rightHandSide: {
										argumentTypes: null,
										id: 1938,
										name: "permission",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 1927,
										src: "19607:10:2",
										typeDescriptions: {
											typeIdentifier: "t_uint8",
											typeString: "uint8"
										}
									},
									src: "19590:27:2",
									typeDescriptions: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									}
								},
								id: 1940,
								nodeType: "ExpressionStatement",
								src: "19590:27:2"
							},
							{
								expression: {
									argumentTypes: null,
									id: 1947,
									isConstant: false,
									isLValue: false,
									isPure: false,
									lValueRequested: false,
									leftHandSide: {
										argumentTypes: null,
										id: 1941,
										name: "tableMetadata",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 1935,
										src: "19627:13:2",
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
										id: 1946,
										isConstant: false,
										isLValue: false,
										isPure: false,
										lValueRequested: false,
										leftExpression: {
											argumentTypes: null,
											"arguments": [
												{
													argumentTypes: null,
													id: 1943,
													name: "delegate",
													nodeType: "Identifier",
													overloadedDeclarations: [
													],
													referencedDeclaration: 1929,
													src: "19652:8:2",
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
												id: 1942,
												isConstant: false,
												isLValue: false,
												isPure: true,
												lValueRequested: false,
												nodeType: "ElementaryTypeNameExpression",
												src: "19644:7:2",
												typeDescriptions: {
													typeIdentifier: "t_type$_t_uint160_$",
													typeString: "type(uint160)"
												},
												typeName: "uint160"
											},
											id: 1944,
											isConstant: false,
											isLValue: false,
											isPure: false,
											kind: "typeConversion",
											lValueRequested: false,
											names: [
											],
											nodeType: "FunctionCall",
											src: "19644:17:2",
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
											id: 1945,
											isConstant: false,
											isLValue: false,
											isPure: true,
											kind: "number",
											lValueRequested: false,
											nodeType: "Literal",
											src: "19663:1:2",
											subdenomination: null,
											typeDescriptions: {
												typeIdentifier: "t_rational_8_by_1",
												typeString: "int_const 8"
											},
											value: "8"
										},
										src: "19644:20:2",
										typeDescriptions: {
											typeIdentifier: "t_uint160",
											typeString: "uint160"
										}
									},
									src: "19627:37:2",
									typeDescriptions: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									}
								},
								id: 1948,
								nodeType: "ExpressionStatement",
								src: "19627:37:2"
							},
							{
								expression: {
									argumentTypes: null,
									id: 1955,
									isConstant: false,
									isLValue: false,
									isPure: false,
									lValueRequested: false,
									leftHandSide: {
										argumentTypes: null,
										baseExpression: {
											argumentTypes: null,
											id: 1949,
											name: "_table",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 984,
											src: "19675:6:2",
											typeDescriptions: {
												typeIdentifier: "t_mapping$_t_bytes32_$_t_bytes32_$",
												typeString: "mapping(bytes32 => bytes32)"
											}
										},
										id: 1951,
										indexExpression: {
											argumentTypes: null,
											id: 1950,
											name: "_tableKey",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 1925,
											src: "19682:9:2",
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
										src: "19675:17:2",
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
												id: 1953,
												name: "tableMetadata",
												nodeType: "Identifier",
												overloadedDeclarations: [
												],
												referencedDeclaration: 1935,
												src: "19703:13:2",
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
											id: 1952,
											isConstant: false,
											isLValue: false,
											isPure: true,
											lValueRequested: false,
											nodeType: "ElementaryTypeNameExpression",
											src: "19695:7:2",
											typeDescriptions: {
												typeIdentifier: "t_type$_t_bytes32_$",
												typeString: "type(bytes32)"
											},
											typeName: "bytes32"
										},
										id: 1954,
										isConstant: false,
										isLValue: false,
										isPure: false,
										kind: "typeConversion",
										lValueRequested: false,
										names: [
										],
										nodeType: "FunctionCall",
										src: "19695:22:2",
										typeDescriptions: {
											typeIdentifier: "t_bytes32",
											typeString: "bytes32"
										}
									},
									src: "19675:42:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								id: 1956,
								nodeType: "ExpressionStatement",
								src: "19675:42:2"
							}
						]
					},
					documentation: null,
					id: 1958,
					implemented: true,
					kind: "function",
					modifiers: [
						{
							"arguments": null,
							id: 1932,
							modifierName: {
								argumentTypes: null,
								id: 1931,
								name: "onlyOwner",
								nodeType: "Identifier",
								overloadedDeclarations: [
								],
								referencedDeclaration: 4925,
								src: "19538:9:2",
								typeDescriptions: {
									typeIdentifier: "t_modifier$__$",
									typeString: "modifier ()"
								}
							},
							nodeType: "ModifierInvocation",
							src: "19538:9:2"
						}
					],
					name: "setTableMetadata",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 1930,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1925,
								name: "_tableKey",
								nodeType: "VariableDeclaration",
								scope: 1958,
								src: "19475:17:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 1924,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "19475:7:2",
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
								id: 1927,
								name: "permission",
								nodeType: "VariableDeclaration",
								scope: 1958,
								src: "19494:16:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_uint8",
									typeString: "uint8"
								},
								typeName: {
									id: 1926,
									name: "uint8",
									nodeType: "ElementaryTypeName",
									src: "19494:5:2",
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
								id: 1929,
								name: "delegate",
								nodeType: "VariableDeclaration",
								scope: 1958,
								src: "19512:16:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_address",
									typeString: "address"
								},
								typeName: {
									id: 1928,
									name: "address",
									nodeType: "ElementaryTypeName",
									src: "19512:7:2",
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
						src: "19474:55:2"
					},
					returnParameters: {
						id: 1933,
						nodeType: "ParameterList",
						parameters: [
						],
						src: "19548:0:2"
					},
					scope: 2209,
					src: "19449:275:2",
					stateMutability: "nonpayable",
					superFunction: null,
					visibility: "private"
				},
				{
					body: {
						id: 1961,
						nodeType: "Block",
						src: "19857:2:2",
						statements: [
						]
					},
					documentation: null,
					id: 1962,
					implemented: true,
					kind: "fallback",
					modifiers: [
					],
					name: "",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 1959,
						nodeType: "ParameterList",
						parameters: [
						],
						src: "19837:2:2"
					},
					returnParameters: {
						id: 1960,
						nodeType: "ParameterList",
						parameters: [
						],
						src: "19857:0:2"
					},
					scope: 2209,
					src: "19829:30:2",
					stateMutability: "payable",
					superFunction: null,
					visibility: "external"
				},
				{
					body: {
						id: 2010,
						nodeType: "Block",
						src: "20398:312:2",
						statements: [
							{
								assignments: [
									1988
								],
								declarations: [
									{
										constant: false,
										id: 1988,
										name: "curDateHashed",
										nodeType: "VariableDeclaration",
										scope: 2010,
										src: "20409:21:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_bytes32",
											typeString: "bytes32"
										},
										typeName: {
											id: 1987,
											name: "bytes32",
											nodeType: "ElementaryTypeName",
											src: "20409:7:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 1991,
								initialValue: {
									argumentTypes: null,
									"arguments": [
									],
									expression: {
										argumentTypes: [
										],
										id: 1989,
										name: "getGsnCounter",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 2107,
										src: "20433:13:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_view$__$returns$_t_bytes32_$",
											typeString: "function () view returns (bytes32)"
										}
									},
									id: 1990,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "20433:15:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "20409:39:2"
							},
							{
								assignments: [
									1993
								],
								declarations: [
									{
										constant: false,
										id: 1993,
										name: "curCounter",
										nodeType: "VariableDeclaration",
										scope: 2010,
										src: "20518:18:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										},
										typeName: {
											id: 1992,
											name: "uint256",
											nodeType: "ElementaryTypeName",
											src: "20518:7:2",
											typeDescriptions: {
												typeIdentifier: "t_uint256",
												typeString: "uint256"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 1997,
								initialValue: {
									argumentTypes: null,
									baseExpression: {
										argumentTypes: null,
										id: 1994,
										name: "gsnCounter",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 972,
										src: "20539:10:2",
										typeDescriptions: {
											typeIdentifier: "t_mapping$_t_bytes32_$_t_uint256_$",
											typeString: "mapping(bytes32 => uint256)"
										}
									},
									id: 1996,
									indexExpression: {
										argumentTypes: null,
										id: 1995,
										name: "curDateHashed",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 1988,
										src: "20550:13:2",
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
									src: "20539:25:2",
									typeDescriptions: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "20518:46:2"
							},
							{
								condition: {
									argumentTypes: null,
									commonType: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									},
									id: 2000,
									isConstant: false,
									isLValue: false,
									isPure: false,
									lValueRequested: false,
									leftExpression: {
										argumentTypes: null,
										id: 1998,
										name: "curCounter",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 1993,
										src: "20579:10:2",
										typeDescriptions: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										}
									},
									nodeType: "BinaryOperation",
									operator: ">=",
									rightExpression: {
										argumentTypes: null,
										id: 1999,
										name: "gsnMaxCallsPerDay",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 974,
										src: "20593:17:2",
										typeDescriptions: {
											typeIdentifier: "t_uint40",
											typeString: "uint40"
										}
									},
									src: "20579:31:2",
									typeDescriptions: {
										typeIdentifier: "t_bool",
										typeString: "bool"
									}
								},
								falseBody: null,
								id: 2006,
								nodeType: "IfStatement",
								src: "20575:89:2",
								trueBody: {
									id: 2005,
									nodeType: "Block",
									src: "20611:53:2",
									statements: [
										{
											expression: {
												argumentTypes: null,
												"arguments": [
													{
														argumentTypes: null,
														hexValue: "32",
														id: 2002,
														isConstant: false,
														isLValue: false,
														isPure: true,
														kind: "number",
														lValueRequested: false,
														nodeType: "Literal",
														src: "20651:1:2",
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
													id: 2001,
													name: "_rejectRelayedCall",
													nodeType: "Identifier",
													overloadedDeclarations: [
													],
													referencedDeclaration: 4084,
													src: "20632:18:2",
													typeDescriptions: {
														typeIdentifier: "t_function_internal_pure$_t_uint256_$returns$_t_uint256_$_t_bytes_memory_ptr_$",
														typeString: "function (uint256) pure returns (uint256,bytes memory)"
													}
												},
												id: 2003,
												isConstant: false,
												isLValue: false,
												isPure: false,
												kind: "functionCall",
												lValueRequested: false,
												names: [
												],
												nodeType: "FunctionCall",
												src: "20632:21:2",
												typeDescriptions: {
													typeIdentifier: "t_tuple$_t_uint256_$_t_bytes_memory_ptr_$",
													typeString: "tuple(uint256,bytes memory)"
												}
											},
											functionReturnParameters: 1986,
											id: 2004,
											nodeType: "Return",
											src: "20625:28:2"
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
										id: 2007,
										name: "_approveRelayedCall",
										nodeType: "Identifier",
										overloadedDeclarations: [
											4054,
											4068
										],
										referencedDeclaration: 4054,
										src: "20682:19:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_pure$__$returns$_t_uint256_$_t_bytes_memory_ptr_$",
											typeString: "function () pure returns (uint256,bytes memory)"
										}
									},
									id: 2008,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "20682:21:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$_t_uint256_$_t_bytes_memory_ptr_$",
										typeString: "tuple(uint256,bytes memory)"
									}
								},
								functionReturnParameters: 1986,
								id: 2009,
								nodeType: "Return",
								src: "20675:28:2"
							}
						]
					},
					documentation: "As a first layer of defense we employ a max number of checks per day",
					id: 2011,
					implemented: true,
					kind: "function",
					modifiers: [
					],
					name: "acceptRelayedCall",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 1981,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1964,
								name: "relay",
								nodeType: "VariableDeclaration",
								scope: 2011,
								src: "20091:13:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_address",
									typeString: "address"
								},
								typeName: {
									id: 1963,
									name: "address",
									nodeType: "ElementaryTypeName",
									src: "20091:7:2",
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
								id: 1966,
								name: "from",
								nodeType: "VariableDeclaration",
								scope: 2011,
								src: "20114:12:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_address",
									typeString: "address"
								},
								typeName: {
									id: 1965,
									name: "address",
									nodeType: "ElementaryTypeName",
									src: "20114:7:2",
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
								id: 1968,
								name: "encodedFunction",
								nodeType: "VariableDeclaration",
								scope: 2011,
								src: "20136:30:2",
								stateVariable: false,
								storageLocation: "calldata",
								typeDescriptions: {
									typeIdentifier: "t_bytes_calldata_ptr",
									typeString: "bytes"
								},
								typeName: {
									id: 1967,
									name: "bytes",
									nodeType: "ElementaryTypeName",
									src: "20136:5:2",
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
								id: 1970,
								name: "transactionFee",
								nodeType: "VariableDeclaration",
								scope: 2011,
								src: "20176:22:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_uint256",
									typeString: "uint256"
								},
								typeName: {
									id: 1969,
									name: "uint256",
									nodeType: "ElementaryTypeName",
									src: "20176:7:2",
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
								id: 1972,
								name: "gasPrice",
								nodeType: "VariableDeclaration",
								scope: 2011,
								src: "20208:16:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_uint256",
									typeString: "uint256"
								},
								typeName: {
									id: 1971,
									name: "uint256",
									nodeType: "ElementaryTypeName",
									src: "20208:7:2",
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
								id: 1974,
								name: "gasLimit",
								nodeType: "VariableDeclaration",
								scope: 2011,
								src: "20234:16:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_uint256",
									typeString: "uint256"
								},
								typeName: {
									id: 1973,
									name: "uint256",
									nodeType: "ElementaryTypeName",
									src: "20234:7:2",
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
								id: 1976,
								name: "nonce",
								nodeType: "VariableDeclaration",
								scope: 2011,
								src: "20260:13:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_uint256",
									typeString: "uint256"
								},
								typeName: {
									id: 1975,
									name: "uint256",
									nodeType: "ElementaryTypeName",
									src: "20260:7:2",
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
								id: 1978,
								name: "approvalData",
								nodeType: "VariableDeclaration",
								scope: 2011,
								src: "20283:27:2",
								stateVariable: false,
								storageLocation: "calldata",
								typeDescriptions: {
									typeIdentifier: "t_bytes_calldata_ptr",
									typeString: "bytes"
								},
								typeName: {
									id: 1977,
									name: "bytes",
									nodeType: "ElementaryTypeName",
									src: "20283:5:2",
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
								id: 1980,
								name: "maxPossibleCharge",
								nodeType: "VariableDeclaration",
								scope: 2011,
								src: "20320:25:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_uint256",
									typeString: "uint256"
								},
								typeName: {
									id: 1979,
									name: "uint256",
									nodeType: "ElementaryTypeName",
									src: "20320:7:2",
									typeDescriptions: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "20081:270:2"
					},
					returnParameters: {
						id: 1986,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 1983,
								name: "",
								nodeType: "VariableDeclaration",
								scope: 2011,
								src: "20375:7:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_uint256",
									typeString: "uint256"
								},
								typeName: {
									id: 1982,
									name: "uint256",
									nodeType: "ElementaryTypeName",
									src: "20375:7:2",
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
								id: 1985,
								name: "",
								nodeType: "VariableDeclaration",
								scope: 2011,
								src: "20384:12:2",
								stateVariable: false,
								storageLocation: "memory",
								typeDescriptions: {
									typeIdentifier: "t_bytes_memory_ptr",
									typeString: "bytes"
								},
								typeName: {
									id: 1984,
									name: "bytes",
									nodeType: "ElementaryTypeName",
									src: "20384:5:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes_storage_ptr",
										typeString: "bytes"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "20374:23:2"
					},
					scope: 2209,
					src: "20055:655:2",
					stateMutability: "view",
					superFunction: 3960,
					visibility: "external"
				},
				{
					body: {
						id: 2024,
						nodeType: "Block",
						src: "20778:48:2",
						statements: [
							{
								expression: {
									argumentTypes: null,
									id: 2022,
									isConstant: false,
									isLValue: false,
									isPure: false,
									lValueRequested: false,
									leftHandSide: {
										argumentTypes: null,
										id: 2018,
										name: "gsnMaxCallsPerDay",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 974,
										src: "20788:17:2",
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
												id: 2020,
												name: "max",
												nodeType: "Identifier",
												overloadedDeclarations: [
												],
												referencedDeclaration: 2013,
												src: "20815:3:2",
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
											id: 2019,
											isConstant: false,
											isLValue: false,
											isPure: true,
											lValueRequested: false,
											nodeType: "ElementaryTypeNameExpression",
											src: "20808:6:2",
											typeDescriptions: {
												typeIdentifier: "t_type$_t_uint40_$",
												typeString: "type(uint40)"
											},
											typeName: "uint40"
										},
										id: 2021,
										isConstant: false,
										isLValue: false,
										isPure: false,
										kind: "typeConversion",
										lValueRequested: false,
										names: [
										],
										nodeType: "FunctionCall",
										src: "20808:11:2",
										typeDescriptions: {
											typeIdentifier: "t_uint40",
											typeString: "uint40"
										}
									},
									src: "20788:31:2",
									typeDescriptions: {
										typeIdentifier: "t_uint40",
										typeString: "uint40"
									}
								},
								id: 2023,
								nodeType: "ExpressionStatement",
								src: "20788:31:2"
							}
						]
					},
					documentation: null,
					id: 2025,
					implemented: true,
					kind: "function",
					modifiers: [
						{
							"arguments": null,
							id: 2016,
							modifierName: {
								argumentTypes: null,
								id: 2015,
								name: "onlyOwner",
								nodeType: "Identifier",
								overloadedDeclarations: [
								],
								referencedDeclaration: 4925,
								src: "20768:9:2",
								typeDescriptions: {
									typeIdentifier: "t_modifier$__$",
									typeString: "modifier ()"
								}
							},
							nodeType: "ModifierInvocation",
							src: "20768:9:2"
						}
					],
					name: "setGsnMaxCallsPerDay",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 2014,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 2013,
								name: "max",
								nodeType: "VariableDeclaration",
								scope: 2025,
								src: "20746:11:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_uint256",
									typeString: "uint256"
								},
								typeName: {
									id: 2012,
									name: "uint256",
									nodeType: "ElementaryTypeName",
									src: "20746:7:2",
									typeDescriptions: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "20745:13:2"
					},
					returnParameters: {
						id: 2017,
						nodeType: "ParameterList",
						parameters: [
						],
						src: "20778:0:2"
					},
					scope: 2209,
					src: "20716:110:2",
					stateMutability: "nonpayable",
					superFunction: null,
					visibility: "external"
				},
				{
					body: {
						id: 2047,
						nodeType: "Block",
						src: "21044:243:2",
						statements: [
							{
								assignments: [
									2029
								],
								declarations: [
									{
										constant: false,
										id: 2029,
										name: "curDateHashed",
										nodeType: "VariableDeclaration",
										scope: 2047,
										src: "21055:21:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_bytes32",
											typeString: "bytes32"
										},
										typeName: {
											id: 2028,
											name: "bytes32",
											nodeType: "ElementaryTypeName",
											src: "21055:7:2",
											typeDescriptions: {
												typeIdentifier: "t_bytes32",
												typeString: "bytes32"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 2032,
								initialValue: {
									argumentTypes: null,
									"arguments": [
									],
									expression: {
										argumentTypes: [
										],
										id: 2030,
										name: "getGsnCounter",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 2107,
										src: "21079:13:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_view$__$returns$_t_bytes32_$",
											typeString: "function () view returns (bytes32)"
										}
									},
									id: 2031,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "21079:15:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "21055:39:2"
							},
							{
								assignments: [
									2034
								],
								declarations: [
									{
										constant: false,
										id: 2034,
										name: "curCounter",
										nodeType: "VariableDeclaration",
										scope: 2047,
										src: "21105:18:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										},
										typeName: {
											id: 2033,
											name: "uint256",
											nodeType: "ElementaryTypeName",
											src: "21105:7:2",
											typeDescriptions: {
												typeIdentifier: "t_uint256",
												typeString: "uint256"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 2038,
								initialValue: {
									argumentTypes: null,
									baseExpression: {
										argumentTypes: null,
										id: 2035,
										name: "gsnCounter",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 972,
										src: "21126:10:2",
										typeDescriptions: {
											typeIdentifier: "t_mapping$_t_bytes32_$_t_uint256_$",
											typeString: "mapping(bytes32 => uint256)"
										}
									},
									id: 2037,
									indexExpression: {
										argumentTypes: null,
										id: 2036,
										name: "curDateHashed",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 2029,
										src: "21137:13:2",
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
									src: "21126:25:2",
									typeDescriptions: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "21105:46:2"
							},
							{
								expression: {
									argumentTypes: null,
									id: 2045,
									isConstant: false,
									isLValue: false,
									isPure: false,
									lValueRequested: false,
									leftHandSide: {
										argumentTypes: null,
										baseExpression: {
											argumentTypes: null,
											id: 2039,
											name: "gsnCounter",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 972,
											src: "21162:10:2",
											typeDescriptions: {
												typeIdentifier: "t_mapping$_t_bytes32_$_t_uint256_$",
												typeString: "mapping(bytes32 => uint256)"
											}
										},
										id: 2041,
										indexExpression: {
											argumentTypes: null,
											id: 2040,
											name: "curDateHashed",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 2029,
											src: "21173:13:2",
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
										src: "21162:25:2",
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
										id: 2044,
										isConstant: false,
										isLValue: false,
										isPure: false,
										lValueRequested: false,
										leftExpression: {
											argumentTypes: null,
											id: 2042,
											name: "curCounter",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 2034,
											src: "21190:10:2",
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
											id: 2043,
											isConstant: false,
											isLValue: false,
											isPure: true,
											kind: "number",
											lValueRequested: false,
											nodeType: "Literal",
											src: "21203:1:2",
											subdenomination: null,
											typeDescriptions: {
												typeIdentifier: "t_rational_1_by_1",
												typeString: "int_const 1"
											},
											value: "1"
										},
										src: "21190:14:2",
										typeDescriptions: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										}
									},
									src: "21162:42:2",
									typeDescriptions: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									}
								},
								id: 2046,
								nodeType: "ExpressionStatement",
								src: "21162:42:2"
							}
						]
					},
					documentation: "Increase the GSN Counter for today",
					id: 2048,
					implemented: true,
					kind: "function",
					modifiers: [
					],
					name: "increaseGsnCounter",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 2026,
						nodeType: "ParameterList",
						parameters: [
						],
						src: "21032:2:2"
					},
					returnParameters: {
						id: 2027,
						nodeType: "ParameterList",
						parameters: [
						],
						src: "21044:0:2"
					},
					scope: 2209,
					src: "21005:282:2",
					stateMutability: "nonpayable",
					superFunction: null,
					visibility: "internal"
				},
				{
					body: {
						id: 2106,
						nodeType: "Block",
						src: "21386:332:2",
						statements: [
							{
								assignments: [
									2054
								],
								declarations: [
									{
										constant: false,
										id: 2054,
										name: "curDate",
										nodeType: "VariableDeclaration",
										scope: 2106,
										src: "21397:15:2",
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
											src: "21397:7:2",
											typeDescriptions: {
												typeIdentifier: "t_uint256",
												typeString: "uint256"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 2055,
								initialValue: null,
								nodeType: "VariableDeclarationStatement",
								src: "21397:15:2"
							},
							{
								assignments: [
									2057
								],
								declarations: [
									{
										constant: false,
										id: 2057,
										name: "year",
										nodeType: "VariableDeclaration",
										scope: 2106,
										src: "21423:11:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_uint16",
											typeString: "uint16"
										},
										typeName: {
											id: 2056,
											name: "uint16",
											nodeType: "ElementaryTypeName",
											src: "21423:6:2",
											typeDescriptions: {
												typeIdentifier: "t_uint16",
												typeString: "uint16"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 2062,
								initialValue: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 2060,
											name: "now",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 10930,
											src: "21454:3:2",
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
											id: 2058,
											name: "dateTime",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 968,
											src: "21437:8:2",
											typeDescriptions: {
												typeIdentifier: "t_contract$_DateTime_$956",
												typeString: "contract DateTime"
											}
										},
										id: 2059,
										isConstant: false,
										isLValue: false,
										isPure: false,
										lValueRequested: false,
										memberName: "getYear",
										nodeType: "MemberAccess",
										referencedDeclaration: 941,
										src: "21437:16:2",
										typeDescriptions: {
											typeIdentifier: "t_function_external_pure$_t_uint256_$returns$_t_uint16_$",
											typeString: "function (uint256) pure external returns (uint16)"
										}
									},
									id: 2061,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "21437:21:2",
									typeDescriptions: {
										typeIdentifier: "t_uint16",
										typeString: "uint16"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "21423:35:2"
							},
							{
								assignments: [
									2064
								],
								declarations: [
									{
										constant: false,
										id: 2064,
										name: "month",
										nodeType: "VariableDeclaration",
										scope: 2106,
										src: "21468:11:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_uint8",
											typeString: "uint8"
										},
										typeName: {
											id: 2063,
											name: "uint8",
											nodeType: "ElementaryTypeName",
											src: "21468:5:2",
											typeDescriptions: {
												typeIdentifier: "t_uint8",
												typeString: "uint8"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 2069,
								initialValue: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 2067,
											name: "now",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 10930,
											src: "21500:3:2",
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
											id: 2065,
											name: "dateTime",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 968,
											src: "21482:8:2",
											typeDescriptions: {
												typeIdentifier: "t_contract$_DateTime_$956",
												typeString: "contract DateTime"
											}
										},
										id: 2066,
										isConstant: false,
										isLValue: false,
										isPure: false,
										lValueRequested: false,
										memberName: "getMonth",
										nodeType: "MemberAccess",
										referencedDeclaration: 948,
										src: "21482:17:2",
										typeDescriptions: {
											typeIdentifier: "t_function_external_pure$_t_uint256_$returns$_t_uint8_$",
											typeString: "function (uint256) pure external returns (uint8)"
										}
									},
									id: 2068,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "21482:22:2",
									typeDescriptions: {
										typeIdentifier: "t_uint8",
										typeString: "uint8"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "21468:36:2"
							},
							{
								assignments: [
									2071
								],
								declarations: [
									{
										constant: false,
										id: 2071,
										name: "day",
										nodeType: "VariableDeclaration",
										scope: 2106,
										src: "21514:9:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_uint8",
											typeString: "uint8"
										},
										typeName: {
											id: 2070,
											name: "uint8",
											nodeType: "ElementaryTypeName",
											src: "21514:5:2",
											typeDescriptions: {
												typeIdentifier: "t_uint8",
												typeString: "uint8"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 2076,
								initialValue: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 2074,
											name: "now",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 10930,
											src: "21542:3:2",
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
											id: 2072,
											name: "dateTime",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 968,
											src: "21526:8:2",
											typeDescriptions: {
												typeIdentifier: "t_contract$_DateTime_$956",
												typeString: "contract DateTime"
											}
										},
										id: 2073,
										isConstant: false,
										isLValue: false,
										isPure: false,
										lValueRequested: false,
										memberName: "getDay",
										nodeType: "MemberAccess",
										referencedDeclaration: 955,
										src: "21526:15:2",
										typeDescriptions: {
											typeIdentifier: "t_function_external_pure$_t_uint256_$returns$_t_uint8_$",
											typeString: "function (uint256) pure external returns (uint8)"
										}
									},
									id: 2075,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "21526:20:2",
									typeDescriptions: {
										typeIdentifier: "t_uint8",
										typeString: "uint8"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "21514:32:2"
							},
							{
								expression: {
									argumentTypes: null,
									id: 2079,
									isConstant: false,
									isLValue: false,
									isPure: false,
									lValueRequested: false,
									leftHandSide: {
										argumentTypes: null,
										id: 2077,
										name: "curDate",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 2054,
										src: "21557:7:2",
										typeDescriptions: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										}
									},
									nodeType: "Assignment",
									operator: "|=",
									rightHandSide: {
										argumentTypes: null,
										id: 2078,
										name: "year",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 2057,
										src: "21568:4:2",
										typeDescriptions: {
											typeIdentifier: "t_uint16",
											typeString: "uint16"
										}
									},
									src: "21557:15:2",
									typeDescriptions: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									}
								},
								id: 2080,
								nodeType: "ExpressionStatement",
								src: "21557:15:2"
							},
							{
								expression: {
									argumentTypes: null,
									id: 2087,
									isConstant: false,
									isLValue: false,
									isPure: false,
									lValueRequested: false,
									leftHandSide: {
										argumentTypes: null,
										id: 2081,
										name: "curDate",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 2054,
										src: "21582:7:2",
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
										id: 2086,
										isConstant: false,
										isLValue: false,
										isPure: false,
										lValueRequested: false,
										leftExpression: {
											argumentTypes: null,
											"arguments": [
												{
													argumentTypes: null,
													id: 2083,
													name: "month",
													nodeType: "Identifier",
													overloadedDeclarations: [
													],
													referencedDeclaration: 2064,
													src: "21601:5:2",
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
												id: 2082,
												isConstant: false,
												isLValue: false,
												isPure: true,
												lValueRequested: false,
												nodeType: "ElementaryTypeNameExpression",
												src: "21593:7:2",
												typeDescriptions: {
													typeIdentifier: "t_type$_t_uint256_$",
													typeString: "type(uint256)"
												},
												typeName: "uint256"
											},
											id: 2084,
											isConstant: false,
											isLValue: false,
											isPure: false,
											kind: "typeConversion",
											lValueRequested: false,
											names: [
											],
											nodeType: "FunctionCall",
											src: "21593:14:2",
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
											id: 2085,
											isConstant: false,
											isLValue: false,
											isPure: true,
											kind: "number",
											lValueRequested: false,
											nodeType: "Literal",
											src: "21609:2:2",
											subdenomination: null,
											typeDescriptions: {
												typeIdentifier: "t_rational_16_by_1",
												typeString: "int_const 16"
											},
											value: "16"
										},
										src: "21593:18:2",
										typeDescriptions: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										}
									},
									src: "21582:29:2",
									typeDescriptions: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									}
								},
								id: 2088,
								nodeType: "ExpressionStatement",
								src: "21582:29:2"
							},
							{
								expression: {
									argumentTypes: null,
									id: 2095,
									isConstant: false,
									isLValue: false,
									isPure: false,
									lValueRequested: false,
									leftHandSide: {
										argumentTypes: null,
										id: 2089,
										name: "curDate",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 2054,
										src: "21621:7:2",
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
										id: 2094,
										isConstant: false,
										isLValue: false,
										isPure: false,
										lValueRequested: false,
										leftExpression: {
											argumentTypes: null,
											"arguments": [
												{
													argumentTypes: null,
													id: 2091,
													name: "day",
													nodeType: "Identifier",
													overloadedDeclarations: [
													],
													referencedDeclaration: 2071,
													src: "21640:3:2",
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
												id: 2090,
												isConstant: false,
												isLValue: false,
												isPure: true,
												lValueRequested: false,
												nodeType: "ElementaryTypeNameExpression",
												src: "21632:7:2",
												typeDescriptions: {
													typeIdentifier: "t_type$_t_uint256_$",
													typeString: "type(uint256)"
												},
												typeName: "uint256"
											},
											id: 2092,
											isConstant: false,
											isLValue: false,
											isPure: false,
											kind: "typeConversion",
											lValueRequested: false,
											names: [
											],
											nodeType: "FunctionCall",
											src: "21632:12:2",
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
											id: 2093,
											isConstant: false,
											isLValue: false,
											isPure: true,
											kind: "number",
											lValueRequested: false,
											nodeType: "Literal",
											src: "21646:2:2",
											subdenomination: null,
											typeDescriptions: {
												typeIdentifier: "t_rational_24_by_1",
												typeString: "int_const 24"
											},
											value: "24"
										},
										src: "21632:16:2",
										typeDescriptions: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										}
									},
									src: "21621:27:2",
									typeDescriptions: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									}
								},
								id: 2096,
								nodeType: "ExpressionStatement",
								src: "21621:27:2"
							},
							{
								expression: {
									argumentTypes: null,
									id: 2104,
									isConstant: false,
									isLValue: false,
									isPure: false,
									lValueRequested: false,
									leftHandSide: {
										argumentTypes: null,
										id: 2097,
										name: "curDateHashed",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 2051,
										src: "21659:13:2",
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
														id: 2101,
														name: "curDate",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 2054,
														src: "21702:7:2",
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
														id: 2099,
														name: "abi",
														nodeType: "Identifier",
														overloadedDeclarations: [
														],
														referencedDeclaration: 10915,
														src: "21685:3:2",
														typeDescriptions: {
															typeIdentifier: "t_magic_abi",
															typeString: "abi"
														}
													},
													id: 2100,
													isConstant: false,
													isLValue: false,
													isPure: true,
													lValueRequested: false,
													memberName: "encodePacked",
													nodeType: "MemberAccess",
													referencedDeclaration: null,
													src: "21685:16:2",
													typeDescriptions: {
														typeIdentifier: "t_function_abiencodepacked_pure$__$returns$_t_bytes_memory_ptr_$",
														typeString: "function () pure returns (bytes memory)"
													}
												},
												id: 2102,
												isConstant: false,
												isLValue: false,
												isPure: false,
												kind: "functionCall",
												lValueRequested: false,
												names: [
												],
												nodeType: "FunctionCall",
												src: "21685:25:2",
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
											id: 2098,
											name: "keccak256",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 10922,
											src: "21675:9:2",
											typeDescriptions: {
												typeIdentifier: "t_function_keccak256_pure$_t_bytes_memory_ptr_$returns$_t_bytes32_$",
												typeString: "function (bytes memory) pure returns (bytes32)"
											}
										},
										id: 2103,
										isConstant: false,
										isLValue: false,
										isPure: false,
										kind: "functionCall",
										lValueRequested: false,
										names: [
										],
										nodeType: "FunctionCall",
										src: "21675:36:2",
										typeDescriptions: {
											typeIdentifier: "t_bytes32",
											typeString: "bytes32"
										}
									},
									src: "21659:52:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								id: 2105,
								nodeType: "ExpressionStatement",
								src: "21659:52:2"
							}
						]
					},
					documentation: null,
					id: 2107,
					implemented: true,
					kind: "function",
					modifiers: [
					],
					name: "getGsnCounter",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 2049,
						nodeType: "ParameterList",
						parameters: [
						],
						src: "21337:2:2"
					},
					returnParameters: {
						id: 2052,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 2051,
								name: "curDateHashed",
								nodeType: "VariableDeclaration",
								scope: 2107,
								src: "21363:21:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 2050,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "21363:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "21362:23:2"
					},
					scope: 2209,
					src: "21315:403:2",
					stateMutability: "view",
					superFunction: null,
					visibility: "internal"
				},
				{
					body: {
						id: 2114,
						nodeType: "Block",
						src: "21897:7:2",
						statements: [
						]
					},
					documentation: null,
					id: 2115,
					implemented: true,
					kind: "function",
					modifiers: [
					],
					name: "_preRelayedCall",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 2110,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 2109,
								name: "context",
								nodeType: "VariableDeclaration",
								scope: 2115,
								src: "21848:20:2",
								stateVariable: false,
								storageLocation: "memory",
								typeDescriptions: {
									typeIdentifier: "t_bytes_memory_ptr",
									typeString: "bytes"
								},
								typeName: {
									id: 2108,
									name: "bytes",
									nodeType: "ElementaryTypeName",
									src: "21848:5:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes_storage_ptr",
										typeString: "bytes"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "21847:22:2"
					},
					returnParameters: {
						id: 2113,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 2112,
								name: "",
								nodeType: "VariableDeclaration",
								scope: 2115,
								src: "21888:7:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 2111,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "21888:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "21887:9:2"
					},
					scope: 2209,
					src: "21823:81:2",
					stateMutability: "nonpayable",
					superFunction: 4092,
					visibility: "internal"
				},
				{
					body: {
						id: 2126,
						nodeType: "Block",
						src: "22004:7:2",
						statements: [
						]
					},
					documentation: null,
					id: 2127,
					implemented: true,
					kind: "function",
					modifiers: [
					],
					name: "_postRelayedCall",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 2124,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 2117,
								name: "context",
								nodeType: "VariableDeclaration",
								scope: 2127,
								src: "21936:20:2",
								stateVariable: false,
								storageLocation: "memory",
								typeDescriptions: {
									typeIdentifier: "t_bytes_memory_ptr",
									typeString: "bytes"
								},
								typeName: {
									id: 2116,
									name: "bytes",
									nodeType: "ElementaryTypeName",
									src: "21936:5:2",
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
								id: 2119,
								name: "",
								nodeType: "VariableDeclaration",
								scope: 2127,
								src: "21958:4:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bool",
									typeString: "bool"
								},
								typeName: {
									id: 2118,
									name: "bool",
									nodeType: "ElementaryTypeName",
									src: "21958:4:2",
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
								id: 2121,
								name: "actualCharge",
								nodeType: "VariableDeclaration",
								scope: 2127,
								src: "21964:20:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_uint256",
									typeString: "uint256"
								},
								typeName: {
									id: 2120,
									name: "uint256",
									nodeType: "ElementaryTypeName",
									src: "21964:7:2",
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
								id: 2123,
								name: "",
								nodeType: "VariableDeclaration",
								scope: 2127,
								src: "21986:7:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_bytes32",
									typeString: "bytes32"
								},
								typeName: {
									id: 2122,
									name: "bytes32",
									nodeType: "ElementaryTypeName",
									src: "21986:7:2",
									typeDescriptions: {
										typeIdentifier: "t_bytes32",
										typeString: "bytes32"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "21935:59:2"
					},
					returnParameters: {
						id: 2125,
						nodeType: "ParameterList",
						parameters: [
						],
						src: "22004:0:2"
					},
					scope: 2209,
					src: "21910:101:2",
					stateMutability: "nonpayable",
					superFunction: 4104,
					visibility: "internal"
				},
				{
					body: {
						id: 2148,
						nodeType: "Block",
						src: "22285:92:2",
						statements: [
							{
								assignments: [
									2137
								],
								declarations: [
									{
										constant: false,
										id: 2137,
										name: "relayHub",
										nodeType: "VariableDeclaration",
										scope: 2148,
										src: "22295:21:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_contract$_IRelayHubELA_$3928",
											typeString: "contract IRelayHubELA"
										},
										typeName: {
											contractScope: null,
											id: 2136,
											name: "IRelayHubELA",
											nodeType: "UserDefinedTypeName",
											referencedDeclaration: 3928,
											src: "22295:12:2",
											typeDescriptions: {
												typeIdentifier: "t_contract$_IRelayHubELA_$3928",
												typeString: "contract IRelayHubELA"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 2140,
								initialValue: {
									argumentTypes: null,
									"arguments": [
									],
									expression: {
										argumentTypes: [
										],
										id: 2138,
										name: "getRelayHub",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 2208,
										src: "22319:11:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_view$__$returns$_t_contract$_IRelayHubELA_$3928_$",
											typeString: "function () view returns (contract IRelayHubELA)"
										}
									},
									id: 2139,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "22319:13:2",
									typeDescriptions: {
										typeIdentifier: "t_contract$_IRelayHubELA_$3928",
										typeString: "contract IRelayHubELA"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "22295:37:2"
							},
							{
								expression: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 2144,
											name: "amt",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 2129,
											src: "22360:3:2",
											typeDescriptions: {
												typeIdentifier: "t_uint256",
												typeString: "uint256"
											}
										},
										{
											argumentTypes: null,
											id: 2145,
											name: "dest",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 2131,
											src: "22365:4:2",
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
											id: 2141,
											name: "relayHub",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 2137,
											src: "22342:8:2",
											typeDescriptions: {
												typeIdentifier: "t_contract$_IRelayHubELA_$3928",
												typeString: "contract IRelayHubELA"
											}
										},
										id: 2143,
										isConstant: false,
										isLValue: false,
										isPure: false,
										lValueRequested: false,
										memberName: "withdraw",
										nodeType: "MemberAccess",
										referencedDeclaration: 3782,
										src: "22342:17:2",
										typeDescriptions: {
											typeIdentifier: "t_function_external_nonpayable$_t_uint256_$_t_address_payable_$returns$__$",
											typeString: "function (uint256,address payable) external"
										}
									},
									id: 2146,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "22342:28:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 2147,
								nodeType: "ExpressionStatement",
								src: "22342:28:2"
							}
						]
					},
					documentation: "@dev Withdraw a specific amount of the GSNReceipient funds\n@param amt Amount of wei to withdraw\n@param dest This is the arbitrary withdrawal destination address",
					id: 2149,
					implemented: true,
					kind: "function",
					modifiers: [
						{
							"arguments": null,
							id: 2134,
							modifierName: {
								argumentTypes: null,
								id: 2133,
								name: "onlyOwner",
								nodeType: "Identifier",
								overloadedDeclarations: [
								],
								referencedDeclaration: 4925,
								src: "22275:9:2",
								typeDescriptions: {
									typeIdentifier: "t_modifier$__$",
									typeString: "modifier ()"
								}
							},
							nodeType: "ModifierInvocation",
							src: "22275:9:2"
						}
					],
					name: "withdraw",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 2132,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 2129,
								name: "amt",
								nodeType: "VariableDeclaration",
								scope: 2149,
								src: "22233:11:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_uint256",
									typeString: "uint256"
								},
								typeName: {
									id: 2128,
									name: "uint256",
									nodeType: "ElementaryTypeName",
									src: "22233:7:2",
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
								id: 2131,
								name: "dest",
								nodeType: "VariableDeclaration",
								scope: 2149,
								src: "22246:20:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_address_payable",
									typeString: "address payable"
								},
								typeName: {
									id: 2130,
									name: "address",
									nodeType: "ElementaryTypeName",
									src: "22246:15:2",
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
						src: "22232:35:2"
					},
					returnParameters: {
						id: 2135,
						nodeType: "ParameterList",
						parameters: [
						],
						src: "22285:0:2"
					},
					scope: 2209,
					src: "22215:162:2",
					stateMutability: "nonpayable",
					superFunction: null,
					visibility: "public"
				},
				{
					body: {
						id: 2182,
						nodeType: "Block",
						src: "22598:186:2",
						statements: [
							{
								assignments: [
									2159
								],
								declarations: [
									{
										constant: false,
										id: 2159,
										name: "relayHub",
										nodeType: "VariableDeclaration",
										scope: 2182,
										src: "22608:21:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_contract$_IRelayHubELA_$3928",
											typeString: "contract IRelayHubELA"
										},
										typeName: {
											contractScope: null,
											id: 2158,
											name: "IRelayHubELA",
											nodeType: "UserDefinedTypeName",
											referencedDeclaration: 3928,
											src: "22608:12:2",
											typeDescriptions: {
												typeIdentifier: "t_contract$_IRelayHubELA_$3928",
												typeString: "contract IRelayHubELA"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 2162,
								initialValue: {
									argumentTypes: null,
									"arguments": [
									],
									expression: {
										argumentTypes: [
										],
										id: 2160,
										name: "getRelayHub",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 2208,
										src: "22632:11:2",
										typeDescriptions: {
											typeIdentifier: "t_function_internal_view$__$returns$_t_contract$_IRelayHubELA_$3928_$",
											typeString: "function () view returns (contract IRelayHubELA)"
										}
									},
									id: 2161,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "22632:13:2",
									typeDescriptions: {
										typeIdentifier: "t_contract$_IRelayHubELA_$3928",
										typeString: "contract IRelayHubELA"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "22608:37:2"
							},
							{
								assignments: [
									2164
								],
								declarations: [
									{
										constant: false,
										id: 2164,
										name: "balance",
										nodeType: "VariableDeclaration",
										scope: 2182,
										src: "22655:15:2",
										stateVariable: false,
										storageLocation: "default",
										typeDescriptions: {
											typeIdentifier: "t_uint256",
											typeString: "uint256"
										},
										typeName: {
											id: 2163,
											name: "uint256",
											nodeType: "ElementaryTypeName",
											src: "22655:7:2",
											typeDescriptions: {
												typeIdentifier: "t_uint256",
												typeString: "uint256"
											}
										},
										value: null,
										visibility: "internal"
									}
								],
								id: 2172,
								initialValue: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											"arguments": [
												{
													argumentTypes: null,
													id: 2169,
													name: "this",
													nodeType: "Identifier",
													overloadedDeclarations: [
													],
													referencedDeclaration: 10987,
													src: "22705:4:2",
													typeDescriptions: {
														typeIdentifier: "t_contract$_ELAJSStore_$2209",
														typeString: "contract ELAJSStore"
													}
												}
											],
											expression: {
												argumentTypes: [
													{
														typeIdentifier: "t_contract$_ELAJSStore_$2209",
														typeString: "contract ELAJSStore"
													}
												],
												id: 2168,
												isConstant: false,
												isLValue: false,
												isPure: true,
												lValueRequested: false,
												nodeType: "ElementaryTypeNameExpression",
												src: "22697:7:2",
												typeDescriptions: {
													typeIdentifier: "t_type$_t_address_$",
													typeString: "type(address)"
												},
												typeName: "address"
											},
											id: 2170,
											isConstant: false,
											isLValue: false,
											isPure: false,
											kind: "typeConversion",
											lValueRequested: false,
											names: [
											],
											nodeType: "FunctionCall",
											src: "22697:13:2",
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
												id: 2165,
												name: "getRelayHub",
												nodeType: "Identifier",
												overloadedDeclarations: [
												],
												referencedDeclaration: 2208,
												src: "22673:11:2",
												typeDescriptions: {
													typeIdentifier: "t_function_internal_view$__$returns$_t_contract$_IRelayHubELA_$3928_$",
													typeString: "function () view returns (contract IRelayHubELA)"
												}
											},
											id: 2166,
											isConstant: false,
											isLValue: false,
											isPure: false,
											kind: "functionCall",
											lValueRequested: false,
											names: [
											],
											nodeType: "FunctionCall",
											src: "22673:13:2",
											typeDescriptions: {
												typeIdentifier: "t_contract$_IRelayHubELA_$3928",
												typeString: "contract IRelayHubELA"
											}
										},
										id: 2167,
										isConstant: false,
										isLValue: false,
										isPure: false,
										lValueRequested: false,
										memberName: "balanceOf",
										nodeType: "MemberAccess",
										referencedDeclaration: 3775,
										src: "22673:23:2",
										typeDescriptions: {
											typeIdentifier: "t_function_external_view$_t_address_$returns$_t_uint256_$",
											typeString: "function (address) view external returns (uint256)"
										}
									},
									id: 2171,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "22673:38:2",
									typeDescriptions: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									}
								},
								nodeType: "VariableDeclarationStatement",
								src: "22655:56:2"
							},
							{
								expression: {
									argumentTypes: null,
									"arguments": [
										{
											argumentTypes: null,
											id: 2176,
											name: "balance",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 2164,
											src: "22739:7:2",
											typeDescriptions: {
												typeIdentifier: "t_uint256",
												typeString: "uint256"
											}
										},
										{
											argumentTypes: null,
											id: 2177,
											name: "dest",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 2151,
											src: "22748:4:2",
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
											id: 2173,
											name: "relayHub",
											nodeType: "Identifier",
											overloadedDeclarations: [
											],
											referencedDeclaration: 2159,
											src: "22721:8:2",
											typeDescriptions: {
												typeIdentifier: "t_contract$_IRelayHubELA_$3928",
												typeString: "contract IRelayHubELA"
											}
										},
										id: 2175,
										isConstant: false,
										isLValue: false,
										isPure: false,
										lValueRequested: false,
										memberName: "withdraw",
										nodeType: "MemberAccess",
										referencedDeclaration: 3782,
										src: "22721:17:2",
										typeDescriptions: {
											typeIdentifier: "t_function_external_nonpayable$_t_uint256_$_t_address_payable_$returns$__$",
											typeString: "function (uint256,address payable) external"
										}
									},
									id: 2178,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "22721:32:2",
									typeDescriptions: {
										typeIdentifier: "t_tuple$__$",
										typeString: "tuple()"
									}
								},
								id: 2179,
								nodeType: "ExpressionStatement",
								src: "22721:32:2"
							},
							{
								expression: {
									argumentTypes: null,
									id: 2180,
									name: "balance",
									nodeType: "Identifier",
									overloadedDeclarations: [
									],
									referencedDeclaration: 2164,
									src: "22770:7:2",
									typeDescriptions: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									}
								},
								functionReturnParameters: 2157,
								id: 2181,
								nodeType: "Return",
								src: "22763:14:2"
							}
						]
					},
					documentation: "@dev Withdraw all the GSNReceipient funds\n@param dest This is the arbitrary withdrawal destination address",
					id: 2183,
					implemented: true,
					kind: "function",
					modifiers: [
						{
							"arguments": null,
							id: 2154,
							modifierName: {
								argumentTypes: null,
								id: 2153,
								name: "onlyOwner",
								nodeType: "Identifier",
								overloadedDeclarations: [
								],
								referencedDeclaration: 4925,
								src: "22570:9:2",
								typeDescriptions: {
									typeIdentifier: "t_modifier$__$",
									typeString: "modifier ()"
								}
							},
							nodeType: "ModifierInvocation",
							src: "22570:9:2"
						}
					],
					name: "withdrawAll",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 2152,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 2151,
								name: "dest",
								nodeType: "VariableDeclaration",
								scope: 2183,
								src: "22541:20:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_address_payable",
									typeString: "address payable"
								},
								typeName: {
									id: 2150,
									name: "address",
									nodeType: "ElementaryTypeName",
									src: "22541:15:2",
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
						src: "22540:22:2"
					},
					returnParameters: {
						id: 2157,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 2156,
								name: "",
								nodeType: "VariableDeclaration",
								scope: 2183,
								src: "22589:7:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_uint256",
									typeString: "uint256"
								},
								typeName: {
									id: 2155,
									name: "uint256",
									nodeType: "ElementaryTypeName",
									src: "22589:7:2",
									typeDescriptions: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "22588:9:2"
					},
					scope: 2209,
					src: "22520:264:2",
					stateMutability: "nonpayable",
					superFunction: null,
					visibility: "public"
				},
				{
					body: {
						id: 2196,
						nodeType: "Block",
						src: "22845:62:2",
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
													id: 2192,
													name: "this",
													nodeType: "Identifier",
													overloadedDeclarations: [
													],
													referencedDeclaration: 10987,
													src: "22894:4:2",
													typeDescriptions: {
														typeIdentifier: "t_contract$_ELAJSStore_$2209",
														typeString: "contract ELAJSStore"
													}
												}
											],
											expression: {
												argumentTypes: [
													{
														typeIdentifier: "t_contract$_ELAJSStore_$2209",
														typeString: "contract ELAJSStore"
													}
												],
												id: 2191,
												isConstant: false,
												isLValue: false,
												isPure: true,
												lValueRequested: false,
												nodeType: "ElementaryTypeNameExpression",
												src: "22886:7:2",
												typeDescriptions: {
													typeIdentifier: "t_type$_t_address_$",
													typeString: "type(address)"
												},
												typeName: "address"
											},
											id: 2193,
											isConstant: false,
											isLValue: false,
											isPure: false,
											kind: "typeConversion",
											lValueRequested: false,
											names: [
											],
											nodeType: "FunctionCall",
											src: "22886:13:2",
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
												id: 2188,
												name: "getRelayHub",
												nodeType: "Identifier",
												overloadedDeclarations: [
												],
												referencedDeclaration: 2208,
												src: "22862:11:2",
												typeDescriptions: {
													typeIdentifier: "t_function_internal_view$__$returns$_t_contract$_IRelayHubELA_$3928_$",
													typeString: "function () view returns (contract IRelayHubELA)"
												}
											},
											id: 2189,
											isConstant: false,
											isLValue: false,
											isPure: false,
											kind: "functionCall",
											lValueRequested: false,
											names: [
											],
											nodeType: "FunctionCall",
											src: "22862:13:2",
											typeDescriptions: {
												typeIdentifier: "t_contract$_IRelayHubELA_$3928",
												typeString: "contract IRelayHubELA"
											}
										},
										id: 2190,
										isConstant: false,
										isLValue: false,
										isPure: false,
										lValueRequested: false,
										memberName: "balanceOf",
										nodeType: "MemberAccess",
										referencedDeclaration: 3775,
										src: "22862:23:2",
										typeDescriptions: {
											typeIdentifier: "t_function_external_view$_t_address_$returns$_t_uint256_$",
											typeString: "function (address) view external returns (uint256)"
										}
									},
									id: 2194,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "functionCall",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "22862:38:2",
									typeDescriptions: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									}
								},
								functionReturnParameters: 2187,
								id: 2195,
								nodeType: "Return",
								src: "22855:45:2"
							}
						]
					},
					documentation: null,
					id: 2197,
					implemented: true,
					kind: "function",
					modifiers: [
					],
					name: "getGSNBalance",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 2184,
						nodeType: "ParameterList",
						parameters: [
						],
						src: "22812:2:2"
					},
					returnParameters: {
						id: 2187,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 2186,
								name: "",
								nodeType: "VariableDeclaration",
								scope: 2197,
								src: "22836:7:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_uint256",
									typeString: "uint256"
								},
								typeName: {
									id: 2185,
									name: "uint256",
									nodeType: "ElementaryTypeName",
									src: "22836:7:2",
									typeDescriptions: {
										typeIdentifier: "t_uint256",
										typeString: "uint256"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "22835:9:2"
					},
					scope: 2209,
					src: "22790:117:2",
					stateMutability: "view",
					superFunction: null,
					visibility: "public"
				},
				{
					body: {
						id: 2207,
						nodeType: "Block",
						src: "22973:52:2",
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
												id: 2203,
												name: "_getRelayHub",
												nodeType: "Identifier",
												overloadedDeclarations: [
												],
												referencedDeclaration: 3470,
												src: "23003:12:2",
												typeDescriptions: {
													typeIdentifier: "t_function_internal_view$__$returns$_t_address_$",
													typeString: "function () view returns (address)"
												}
											},
											id: 2204,
											isConstant: false,
											isLValue: false,
											isPure: false,
											kind: "functionCall",
											lValueRequested: false,
											names: [
											],
											nodeType: "FunctionCall",
											src: "23003:14:2",
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
										id: 2202,
										name: "IRelayHubELA",
										nodeType: "Identifier",
										overloadedDeclarations: [
										],
										referencedDeclaration: 3928,
										src: "22990:12:2",
										typeDescriptions: {
											typeIdentifier: "t_type$_t_contract$_IRelayHubELA_$3928_$",
											typeString: "type(contract IRelayHubELA)"
										}
									},
									id: 2205,
									isConstant: false,
									isLValue: false,
									isPure: false,
									kind: "typeConversion",
									lValueRequested: false,
									names: [
									],
									nodeType: "FunctionCall",
									src: "22990:28:2",
									typeDescriptions: {
										typeIdentifier: "t_contract$_IRelayHubELA_$3928",
										typeString: "contract IRelayHubELA"
									}
								},
								functionReturnParameters: 2201,
								id: 2206,
								nodeType: "Return",
								src: "22983:35:2"
							}
						]
					},
					documentation: null,
					id: 2208,
					implemented: true,
					kind: "function",
					modifiers: [
					],
					name: "getRelayHub",
					nodeType: "FunctionDefinition",
					parameters: {
						id: 2198,
						nodeType: "ParameterList",
						parameters: [
						],
						src: "22933:2:2"
					},
					returnParameters: {
						id: 2201,
						nodeType: "ParameterList",
						parameters: [
							{
								constant: false,
								id: 2200,
								name: "",
								nodeType: "VariableDeclaration",
								scope: 2208,
								src: "22959:12:2",
								stateVariable: false,
								storageLocation: "default",
								typeDescriptions: {
									typeIdentifier: "t_contract$_IRelayHubELA_$3928",
									typeString: "contract IRelayHubELA"
								},
								typeName: {
									contractScope: null,
									id: 2199,
									name: "IRelayHubELA",
									nodeType: "UserDefinedTypeName",
									referencedDeclaration: 3928,
									src: "22959:12:2",
									typeDescriptions: {
										typeIdentifier: "t_contract$_IRelayHubELA_$3928",
										typeString: "contract IRelayHubELA"
									}
								},
								value: null,
								visibility: "internal"
							}
						],
						src: "22958:14:2"
					},
					scope: 2209,
					src: "22913:112:2",
					stateMutability: "view",
					superFunction: null,
					visibility: "internal"
				}
			],
			scope: 2210,
			src: "782:22245:2"
		}
	],
	src: "0:23028:2"
};
var bytecode = "0x608060405273edb211a2dbbde62012440177e65b68e0a66e4531606660006101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff160217905550615ec0806100686000396000f3fe608060405260043610610195576000357c0100000000000000000000000000000000000000000000000000000000900463ffffffff168062f714ce1461019757806301ee810a146101c05780631fd6dda5146101eb578063287e724614610228578063365628a2146102665780633c2e85991461028f5780634102fbf6146102ba57806359cb73a4146102e5578063621d114e146103225780636729003c1461034b578063715018a61461038857806374e861d61461039f57806380274db7146103ca5780638129fc1c1461040757806383947ea01461041e5780638da5cb5b1461045c5780638f32d59b1461048757806392e8aa6b146104b2578063a2ea7c6e146104db578063ad61ccd514610518578063bc41c3dd14610543578063c2309bf91461056c578063c4d66de8146105a9578063d2c5ce31146105d2578063d887f105146105fd578063e06e0e221461063b578063e293d81714610664578063ed90cb371461068d578063f201fe2a146106b6578063f2fde38b146106f3578063fa09e6301461071c578063fc4812f214610759575b005b3480156101a357600080fd5b506101be60048036036101b99190810190614cbc565b610782565b005b3480156101cc57600080fd5b506101d5610864565b6040516101e29190615c3c565b60405180910390f35b3480156101f757600080fd5b50610212600480360361020d91908101906148e6565b61087b565b60405161021f9190615785565b60405180910390f35b34801561023457600080fd5b5061024f600480360361024a91908101906148e6565b610898565b60405161025d92919061573a565b60405180910390f35b34801561027257600080fd5b5061028d60048036036102889190810190614ad5565b6108ee565b005b34801561029b57600080fd5b506102a4610a1a565b6040516102b19190615b9f565b60405180910390f35b3480156102c657600080fd5b506102cf610acd565b6040516102dc91906157a0565b60405180910390f35b3480156102f157600080fd5b5061030c600480360361030791908101906148e6565b610af4565b6040516103199190615b9f565b60405180910390f35b34801561032e57600080fd5b5061034960048036036103449190810190614a37565b610b0c565b005b34801561035757600080fd5b50610372600480360361036d91908101906148e6565b610e35565b60405161037f91906157a0565b60405180910390f35b34801561039457600080fd5b5061039d610e78565b005b3480156103ab57600080fd5b506103b4610f82565b6040516103c19190615704565b60405180910390f35b3480156103d657600080fd5b506103f160048036036103ec9190810190614b7c565b610f91565b6040516103fe91906157a0565b60405180910390f35b34801561041357600080fd5b5061041c61105f565b005b34801561042a57600080fd5b50610445600480360361044091908101906147e6565b611163565b604051610453929190615c0c565b60405180910390f35b34801561046857600080fd5b506104716111e2565b60405161047e9190615704565b60405180910390f35b34801561049357600080fd5b5061049c61120c565b6040516104a99190615785565b60405180910390f35b3480156104be57600080fd5b506104d960048036036104d49190810190614a37565b61126b565b005b3480156104e757600080fd5b5061050260048036036104fd91908101906148e6565b6114cd565b60405161050f9190615b7d565b60405180910390f35b34801561052457600080fd5b5061052d6114fe565b60405161053a91906157bb565b60405180910390f35b34801561054f57600080fd5b5061056a60048036036105659190810190614c6a565b61153b565b005b34801561057857600080fd5b50610593600480360361058e91908101906148e6565b6115aa565b6040516105a09190615763565b60405180910390f35b3480156105b557600080fd5b506105d060048036036105cb9190810190614794565b611623565b005b3480156105de57600080fd5b506105e76117cd565b6040516105f49190615704565b60405180910390f35b34801561060957600080fd5b50610624600480360361061f91908101906148e6565b6117e5565b604051610632929190615bba565b60405180910390f35b34801561064757600080fd5b50610662600480360361065d9190810190614bc1565b61187a565b005b34801561067057600080fd5b5061068b6004803603610686919081019061494b565b611948565b005b34801561069957600080fd5b506106b460048036036106af919081019061490f565b611c16565b005b3480156106c257600080fd5b506106dd60048036036106d8919081019061490f565b611cb2565b6040516106ea9190615785565b60405180910390f35b3480156106ff57600080fd5b5061071a60048036036107159190810190614794565b611cd2565b005b34801561072857600080fd5b50610743600480360361073e91908101906147bd565b611d27565b6040516107509190615b9f565b60405180910390f35b34801561076557600080fd5b50610780600480360361077b91908101906149ae565b611ec0565b005b61078a61120c565b15156107cb576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016107c2906159bd565b60405180910390fd5b60006107d561222e565b90508073ffffffffffffffffffffffffffffffffffffffff1662f714ce84846040518363ffffffff167c010000000000000000000000000000000000000000000000000000000002815260040161082d929190615be3565b600060405180830381600087803b15801561084757600080fd5b505af115801561085b573d6000803e3d6000fd5b50505050505050565b606860009054906101000a900464ffffffffff1681565b600061089182606d61223d90919063ffffffff16565b9050919050565b60008060006108b184606d6122b490919063ffffffff16565b600190049050807c0100000000000000000000000000000000000000000000000000000000029150602081908060020a8204915050925050915091565b6108f661120c565b1515610937576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040161092e906159bd565b60405180910390fd5b60006001026069600086815260200190815260200160002054141515610992576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040161098990615a7d565b60405180910390fd5b60008090506109a28585836122d4565b6109db7f736368656d61732e7075626c69632e7461626c6573000000000000000000000060010287606d6123809092919063ffffffff16565b506109f085606a6124ab90919063ffffffff16565b506109f96144c5565b610a048785856124cb565b9050610a108682612548565b5050505050505050565b6000610a2461222e565b73ffffffffffffffffffffffffffffffffffffffff166370a08231306040518263ffffffff167c0100000000000000000000000000000000000000000000000000000000028152600401610a78919061571f565b60206040518083038186803b158015610a9057600080fd5b505afa158015610aa4573d6000803e3d6000fd5b505050506040513d601f19601f82011682018060405250610ac89190810190614c93565b905090565b7f736368656d61732e7075626c69632e7461626c6573000000000000000000000060010281565b60676020528060005260406000206000915090505481565b868487600080610b1b856117e5565b91509150600082111515610b64576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401610b5b9061583d565b60405180910390fd5b6001821180610b7e575060011515610b7a61120c565b1515145b80610bbb5750610b8c612576565b73ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff16145b1515610bfc576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401610bf3906158dd565b60405180910390fd5b60011515610c0b8587866125ca565b1515141515610c4f576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401610c469061589d565b60405180910390fd5b600282101515610d57576000610c6f84606d6122b490919063ffffffff16565b9050600060208260019004908060020a82049150509050610c8e612576565b73ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff161415610cc657610d54565b60011515610cd261120c565b15151480610d125750610ce3612576565b73ffffffffffffffffffffffffffffffffffffffff168373ffffffffffffffffffffffffffffffffffffffff16145b1515610d53576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401610d4a9061595d565b60405180910390fd5b5b50505b60011515610d718d89606a61262a9092919063ffffffff16565b1515141515610db5576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401610dac90615afd565b60405180910390fd5b60011515610dc4898d8d6125ca565b1515141515610e08576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401610dff90615b5d565b60405180910390fd5b610e10612675565b610e268a87606d6126b89092919063ffffffff16565b50505050505050505050505050565b6000610e4b82606d61223d90919063ffffffff16565b15610e6b57610e6482606d6122b490919063ffffffff16565b9050610e73565b600060010290505b919050565b610e8061120c565b1515610ec1576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401610eb8906159bd565b60405180910390fd5b600073ffffffffffffffffffffffffffffffffffffffff16603360009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff167f8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e060405160405180910390a36000603360006101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff160217905550565b6000610f8c6127e3565b905090565b6000610f9b610f82565b73ffffffffffffffffffffffffffffffffffffffff163373ffffffffffffffffffffffffffffffffffffffff1614151561100a576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401611001906157fd565b60405180910390fd5b61105783838080601f016020809104026020016040519081016040528093929190818152602001838380828437600081840152601f19601f82011690508083019250505050505050612814565b905092915050565b600060019054906101000a900460ff168061107e575061107d61281b565b5b8061109557506000809054906101000a900460ff16155b15156110d6576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016110cd906159dd565b60405180910390fd5b60008060019054906101000a900460ff161590508015611126576001600060016101000a81548160ff02191690831515021790555060016000806101000a81548160ff0219169083151502179055505b61112f33611623565b611137612832565b61113f612925565b80156111605760008060016101000a81548160ff0219169083151502179055505b50565b600060606000611171612987565b9050600060676000838152602001908152602001600020549050606860009054906101000a900464ffffffffff1664ffffffffff16811015156111c3576111b86002612c42565b9350935050506111d2565b6111cb612c64565b9350935050505b9b509b9950505050505050505050565b6000603360009054906101000a900473ffffffffffffffffffffffffffffffffffffffff16905090565b6000603360009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff1661124f612576565b73ffffffffffffffffffffffffffffffffffffffff1614905090565b86848760008061127a856117e5565b915091506000821115156112c3576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016112ba9061587d565b60405180910390fd5b60018211806112dd5750600115156112d961120c565b1515145b8061131a57506112eb612576565b73ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff16145b151561135b576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016113529061597d565b60405180910390fd5b6001151561136a8587866125ca565b15151415156113ae576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016113a59061589d565b60405180910390fd5b600015156113c68b606d61223d90919063ffffffff16565b151514151561140a576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401611401906159fd565b60405180910390fd5b60011515611419898d8d6125ca565b151514151561145d576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040161145490615b5d565b60405180910390fd5b611465612675565b61147b8c88606a612c899092919063ffffffff16565b50600015156114948c606d61223d90919063ffffffff16565b151514156114a8576114a78b888e612cd4565b5b6114be8a87606d6126b89092919063ffffffff16565b50505050505050505050505050565b6114d56144c5565b60606114eb83606d61307690919063ffffffff16565b90506114f681613096565b915050919050565b60606040805190810160405280600581526020017f312e302e30000000000000000000000000000000000000000000000000000000815250905090565b61154361120c565b1515611584576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040161157b906159bd565b60405180910390fd5b80606860006101000a81548164ffffffffff021916908364ffffffffff16021790555050565b6060600115156115c483606a61313f90919063ffffffff16565b1515141515611608576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016115ff90615abd565b60405180910390fd5b61161c82606a61315f90919063ffffffff16565b9050919050565b600060019054906101000a900460ff1680611642575061164161281b565b5b8061165957506000809054906101000a900460ff16155b151561169a576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401611691906159dd565b60405180910390fd5b60008060019054906101000a900460ff1615905080156116ea576001600060016101000a81548160ff02191690831515021790555060016000806101000a81548160ff0219169083151502179055505b81603360006101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff160217905550603360009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16600073ffffffffffffffffffffffffffffffffffffffff167f8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e060405160405180910390a380156117c95760008060016101000a81548160ff0219169083151502179055505b5050565b73edb211a2dbbde62012440177e65b68e0a66e453181565b60008060006001026069600085815260200190815260200160002054111515611843576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040161183a90615b1d565b60405180910390fd5b600060696000858152602001908152602001600020546001900490508060ff169250600881908060020a8204915050915050915091565b611882610f82565b73ffffffffffffffffffffffffffffffffffffffff163373ffffffffffffffffffffffffffffffffffffffff161415156118f1576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016118e8906157fd565b60405180910390fd5b61194185858080601f016020809104026020016040519081016040528093929190818152602001838380828437600081840152601f19601f820116905080830192505050505050508484846131ce565b5050505050565b83838383600115156119668583606a61262a9092919063ffffffff16565b15151415156119aa576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016119a190615a9d565b60405180910390fd5b6000806119b6866117e5565b915091506000821115156119ff576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016119f69061581d565b60405180910390fd5b6001821180611a19575060011515611a1561120c565b1515145b80611a565750611a27612576565b73ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff16145b1515611a97576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401611a8e90615a1d565b60405180910390fd5b60011515611aa68588886125ca565b1515141515611aea576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401611ae19061589d565b60405180910390fd5b600282101515611beb57611afc61120c565b80611b395750611b0a612576565b73ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff16145b15611b4357611bea565b6000611b5986606d6122b490919063ffffffff16565b9050600060208260019004908060020a82049150509050611b78612576565b73ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff16141515611be7576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401611bde90615b3d565b60405180910390fd5b50505b5b611bf3612675565b611c098a88606a6131d49092919063ffffffff16565b5050505050505050505050565b611c1e61120c565b1515611c5f576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401611c56906159bd565b60405180910390fd5b611c987f736368656d61732e7075626c69632e7461626c6573000000000000000000000060010283606d61321f9092919063ffffffff16565b50611cad81606a61324290919063ffffffff16565b505050565b6000611cca8383606a61262a9092919063ffffffff16565b905092915050565b611cda61120c565b1515611d1b576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401611d12906159bd565b60405180910390fd5b611d248161327b565b50565b6000611d3161120c565b1515611d72576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401611d69906159bd565b60405180910390fd5b6000611d7c61222e565b90506000611d8861222e565b73ffffffffffffffffffffffffffffffffffffffff166370a08231306040518263ffffffff167c0100000000000000000000000000000000000000000000000000000000028152600401611ddc919061571f565b60206040518083038186803b158015611df457600080fd5b505afa158015611e08573d6000803e3d6000fd5b505050506040513d601f19601f82011682018060405250611e2c9190810190614c93565b90508173ffffffffffffffffffffffffffffffffffffffff1662f714ce82866040518363ffffffff167c0100000000000000000000000000000000000000000000000000000000028152600401611e84929190615be3565b600060405180830381600087803b158015611e9e57600080fd5b505af1158015611eb2573d6000803e3d6000fd5b505050508092505050919050565b8585858560011515611ede8583606a61262a9092919063ffffffff16565b1515141515611f22576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401611f1990615a9d565b60405180910390fd5b600080611f2e866117e5565b91509150600082111515611f77576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401611f6e9061581d565b60405180910390fd5b6001821180611f91575060011515611f8d61120c565b1515145b80611fce5750611f9f612576565b73ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff16145b151561200f576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040161200690615a1d565b60405180910390fd5b6001151561201e8588886125ca565b1515141515612062576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016120599061589d565b60405180910390fd5b6002821015156121635761207461120c565b806120b15750612082612576565b73ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff16145b156120bb57612162565b60006120d186606d6122b490919063ffffffff16565b9050600060208260019004908060020a820491505090506120f0612576565b73ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff1614151561215f576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040161215690615b3d565b60405180910390fd5b50505b5b60011515612172898d8a6125ca565b15151415156121b6576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016121ad90615b5d565b60405180910390fd5b6121be612675565b60006121d488606d6133ad90919063ffffffff16565b90506001151581151514151561221f576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016122169061599d565b60405180910390fd5b50505050505050505050505050565b60006122386127e3565b905090565b6000612255828460000161342490919063ffffffff16565b806122725750612271828460030161344490919063ffffffff16565b5b8061228f575061228e828460060161313f90919063ffffffff16565b5b806122ac57506122ab828460090161346490919063ffffffff16565b5b905092915050565b60006122cc828460000161348490919063ffffffff16565b905092915050565b6122dc61120c565b151561231d576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401612314906159bd565b60405180910390fd5b60008260ff168117905060088273ffffffffffffffffffffffffffffffffffffffff169060020a0273ffffffffffffffffffffffffffffffffffffffff168117905080600102606960008681526020019081526020016000208190555050505050565b6000612398838560000161342490919063ffffffff16565b1515156123da576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016123d1906158fd565b60405180910390fd5b6123f0838560030161344490919063ffffffff16565b151515612432576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401612429906158fd565b60405180910390fd5b612448838560090161346490919063ffffffff16565b15151561248a576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401612481906158fd565b60405180910390fd5b6124a2838386600601612c899092919063ffffffff16565b90509392505050565b60006124c382846001016134ef90919063ffffffff16565b905092915050565b6124d36144c5565b81518351141515612519576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016125109061593d565b60405180910390fd5b6125216144c5565b84816000018181525050612535848461355b565b8160200181905250809150509392505050565b6000606061255583613671565b905061256d8482606d6137419092919063ffffffff16565b91505092915050565b60006125806127e3565b73ffffffffffffffffffffffffffffffffffffffff163373ffffffffffffffffffffffffffffffffffffffff161415156125bc573390506125c7565b6125c461386c565b90505b90565b60006060604080519080825280601f01601f1916602001820160405280156126015781602001600182028038833980820191505090505b509050846040820152836020820152600081805190602001209050838114925050509392505050565b6000612636848461313f565b1561266957612662828560000160008681526020019081526020016000206138e490919063ffffffff16565b905061266e565b600090505b9392505050565b600061267f612987565b90506000606760008381526020019081526020016000205490506001810160676000848152602001908152602001600020819055505050565b60006126d0838560030161344490919063ffffffff16565b151515612712576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401612709906158fd565b60405180910390fd5b612728838560060161313f90919063ffffffff16565b15151561276a576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401612761906158fd565b60405180910390fd5b612780838560090161346490919063ffffffff16565b1515156127c2576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016127b9906158fd565b60405180910390fd5b6127da8383866000016139079092919063ffffffff16565b90509392505050565b6000807f06b7792c761dcc05af1761f0315ce8b01ac39c16cc934eb0b2f7a8e71414f2626001029050805491505090565b6000919050565b6000803090506000813b9050600081149250505090565b600060019054906101000a900460ff1680612851575061285061281b565b5b8061286857506000809054906101000a900460ff16155b15156128a9576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016128a0906159dd565b60405180910390fd5b60008060019054906101000a900460ff1615905080156128f9576001600060016101000a81548160ff02191690831515021790555060016000806101000a81548160ff0219169083151502179055505b612901613942565b80156129225760008060016101000a81548160ff0219169083151502179055505b50565b6103e8606860006101000a81548164ffffffffff021916908364ffffffffff1602179055506129847f736368656d61732e7075626c69632e7461626c657300000000000000000000006001026000606d613a4a9092919063ffffffff16565b50565b6000806000606660009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff166392d66313426040518263ffffffff167c0100000000000000000000000000000000000000000000000000000000028152600401612a039190615b9f565b60206040518083038186803b158015612a1b57600080fd5b505afa158015612a2f573d6000803e3d6000fd5b505050506040513d601f19601f82011682018060405250612a539190810190614c41565b90506000606660009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff1663a324ad24426040518263ffffffff167c0100000000000000000000000000000000000000000000000000000000028152600401612ace9190615b9f565b60206040518083038186803b158015612ae657600080fd5b505afa158015612afa573d6000803e3d6000fd5b505050506040513d601f19601f82011682018060405250612b1e9190810190614cf8565b90506000606660009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff166365c72840426040518263ffffffff167c0100000000000000000000000000000000000000000000000000000000028152600401612b999190615b9f565b60206040518083038186803b158015612bb157600080fd5b505afa158015612bc5573d6000803e3d6000fd5b505050506040513d601f19601f82011682018060405250612be99190810190614cf8565b90508261ffff168417935060108260ff169060020a028417935060188160ff169060020a028417935083604051602001808281526020019150506040516020818303038152906040528051906020012094505050505090565b6000606082600b01602060405190810160405280600081525091509150915091565b60006060612c816020604051908101604052806000815250613d32565b915091509091565b6000612c95848461313f565b15612cc857612cc1828560000160008681526020019081526020016000206134ef90919063ffffffff16565b9050612ccd565b600090505b9392505050565b60001515612cec84606d61223d90919063ffffffff16565b1515141515612d30576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401612d279061591d565b60405180910390fd5b600080606660009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff166392d66313426040518263ffffffff167c0100000000000000000000000000000000000000000000000000000000028152600401612daa9190615b9f565b60206040518083038186803b158015612dc257600080fd5b505afa158015612dd6573d6000803e3d6000fd5b505050506040513d601f19601f82011682018060405250612dfa9190810190614c41565b90506000606660009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff1663a324ad24426040518263ffffffff167c0100000000000000000000000000000000000000000000000000000000028152600401612e759190615b9f565b60206040518083038186803b158015612e8d57600080fd5b505afa158015612ea1573d6000803e3d6000fd5b505050506040513d601f19601f82011682018060405250612ec59190810190614cf8565b90506000606660009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff166365c72840426040518263ffffffff167c0100000000000000000000000000000000000000000000000000000000028152600401612f409190615b9f565b60206040518083038186803b158015612f5857600080fd5b505afa158015612f6c573d6000803e3d6000fd5b505050506040513d601f19601f82011682018060405250612f909190810190614cf8565b90508261ffff168417935060108260ff169060020a028417935060188160ff169060020a02841793506000847c01000000000000000000000000000000000000000000000000000000000290506020612fe7612576565b73ffffffffffffffffffffffffffffffffffffffff169060020a028517945061301f8886600102606d6126b89092919063ffffffff16565b50613028612576565b73ffffffffffffffffffffffffffffffffffffffff1686887fc3b047ab84cb81685163ad3ef7de856809a7d1cd6d900310242d6c3dca034bc160405160405180910390a45050505050505050565b606061308e8284600301613d4290919063ffffffff16565b905092915050565b61309e6144c5565b6000825190506130ac6144c5565b6130bf8285613e4590919063ffffffff16565b8160000181815250506020820391506130e18285613e5390919063ffffffff16565b819150826020018194508290525050600082141515613135576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040161312c906157dd565b60405180910390fd5b8092505050919050565b600061315782846001016138e490919063ffffffff16565b905092915050565b606061316b838361313f565b156131945761318d836000016000848152602001908152602001600020613f5e565b90506131c8565b60006040519080825280602002602001820160405280156131c45781602001602082028038833980820191505090505b5090505b92915050565b50505050565b60006131e0848461313f565b156132135761320c82856000016000868152602001908152602001600020613ffb90919063ffffffff16565b9050613218565b600090505b9392505050565b60006132398383866006016131d49092919063ffffffff16565b90509392505050565b600061324e838361313f565b15613270576132698284600101613ffb90919063ffffffff16565b9050613275565b600090505b92915050565b600073ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff16141515156132ed576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016132e49061585d565b60405180910390fd5b8073ffffffffffffffffffffffffffffffffffffffff16603360009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff167f8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e060405160405180910390a380603360006101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff16021790555050565b60006133c582846000016140f490919063ffffffff16565b806133e257506133e1828460030161414690919063ffffffff16565b5b806133ff57506133fe828460060161324290919063ffffffff16565b5b8061341c575061341b82846009016141a090919063ffffffff16565b5b905092915050565b600061343c82846001016138e490919063ffffffff16565b905092915050565b600061345c82846001016138e490919063ffffffff16565b905092915050565b600061347c82846001016138e490919063ffffffff16565b905092915050565b60006134908383613424565b15156134d1576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016134c890615add565b60405180910390fd5b82600001600083815260200190815260200160002054905092915050565b60006134fb83836138e4565b1515613550578260010182908060018154018082558091505090600182039060005260206000200160009091929091909150558360000160008481526020019081526020016000208190555060019050613555565b600090505b92915050565b6060815183511415156135a3576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040161359a9061593d565b60405180910390fd5b606083516040519080825280602002602001820160405280156135e057816020015b6135cd6144e2565b8152602001906001900390816135c55790505b50905060008090505b8451811015613666576135fa614502565b858281518110151561360857fe5b90602001906020020151816000018181525050848281518110151561362957fe5b9060200190602002015181602001818152505080838381518110151561364b57fe5b906020019060200201819052505080806001019150506135e9565b508091505092915050565b6060600061367e836141d9565b90506060816040519080825280601f01601f1916602001820160405280156136b55781602001600182028038833980820191505090505b5090506136d1828286600001516141f49092919063ffffffff16565b6020820391506136f0828286602001516141fe9092919063ffffffff16565b9150600082141515613737576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040161372e906157dd565b60405180910390fd5b8092505050919050565b6000613759838560000161342490919063ffffffff16565b15151561379b576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401613792906158fd565b60405180910390fd5b6137b1838560060161313f90919063ffffffff16565b1515156137f3576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016137ea906158fd565b60405180910390fd5b613809838560090161346490919063ffffffff16565b15151561384b576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401613842906158fd565b60405180910390fd5b6138638383866003016142bb9092919063ffffffff16565b90509392505050565b600060606000368080601f016020809104026020016040519081016040528093929190818152602001838380828437600081840152601f19601f820116905080830192505050505050509050600080369050905073ffffffffffffffffffffffffffffffffffffffff81830151169250829250505090565b600080836000016000848152602001908152602001600020541415905092915050565b6000818460000160008581526020019081526020016000208190555061393983856001016134ef90919063ffffffff16565b90509392505050565b600060019054906101000a900460ff1680613961575061396061281b565b5b8061397857506000809054906101000a900460ff16155b15156139b9576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016139b0906159dd565b60405180910390fd5b60008060019054906101000a900460ff161590508015613a09576001600060016101000a81548160ff02191690831515021790555060016000806101000a81548160ff0219169083151502179055505b613a26732eda8d1a61824dfa812c4bd139081b9bcb972a6d614306565b8015613a475760008060016101000a81548160ff0219169083151502179055505b50565b60006004826003811115613a5a57fe5b60ff16101515613a9f576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401613a9690615a5d565b60405180910390fd5b613ab5838560000161342490919063ffffffff16565b151515613af7576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401613aee906158fd565b60405180910390fd5b613b0d838560030161344490919063ffffffff16565b151515613b4f576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401613b46906158fd565b60405180910390fd5b613b65838560060161313f90919063ffffffff16565b151515613ba7576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401613b9e906158fd565b60405180910390fd5b613bbd838560090161346490919063ffffffff16565b151515613bff576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401613bf6906158fd565b60405180910390fd5b816003811115613c0b57fe5b60006003811115613c1857fe5b1415613c3b57613c3483856006016124ab90919063ffffffff16565b9050613d2b565b816003811115613c4757fe5b60016003811115613c5457fe5b1415613c7757613c70838560090161447f90919063ffffffff16565b9050613d2b565b816003811115613c8357fe5b60026003811115613c9057fe5b1415613cb957613cb2836000600102866000016139079092919063ffffffff16565b9050613d2b565b816003811115613cc557fe5b600380811115613cd157fe5b1415613d2a57613d238360006040519080825280601f01601f191660200182016040528015613d0f5781602001600182028038833980820191505090505b50866003016142bb9092919063ffffffff16565b9050613d2b565b5b9392505050565b6000606060008391509150915091565b6060613d4e8383613444565b1515613d8f576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401613d8690615add565b60405180910390fd5b8260000160008381526020019081526020016000208054600181600116156101000203166002900480601f016020809104026020016040519081016040528092919081815260200182805460018160011615610100020316600290048015613e385780601f10613e0d57610100808354040283529160200191613e38565b820191906000526020600020905b815481529060010190602001808311613e1b57829003601f168201915b5050505050905092915050565b600081830151905092915050565b60606000808390506000613e70828761449f90919063ffffffff16565b90506020820391506000604082811515613e8657fe5b049050606081604051908082528060200260200182016040528015613ec557816020015b613eb26144e2565b815260200190600190039081613eaa5790505b50905060008090505b82811015613f4c57613ede614502565b613ef1868b613e4590919063ffffffff16565b816000018181525050602086039550613f13868b613e4590919063ffffffff16565b816020018181525050602086039550808383815181101515613f3157fe5b90602001906020020181905250508080600101915050613ece565b50808495509550505050509250929050565b6060808260010180549050604051908082528060200260200182016040528015613f975781602001602082028038833980820191505090505b50905060005b8360010180549050811015613ff1578360010181815481101515613fbd57fe5b90600052602060002001548282815181101515613fd657fe5b90602001906020020181815250508080600101915050613f9d565b5080915050919050565b600061400783836138e4565b156140e957600060018460000160008581526020019081526020016000205403905060006001856001018054905003905081811415156140a0576000856001018281548110151561405457fe5b9060005260206000200154905080866001018481548110151561407357fe5b90600052602060002001819055506001830186600001600083815260200190815260200160002081905550505b846000016000858152602001908152602001600020600090558460010180548015156140c857fe5b600190038181906000526020600020016000905590556001925050506140ee565b600090505b92915050565b60006141008383613424565b1561413b57826000016000838152602001908152602001600020600090556141348284600101613ffb90919063ffffffff16565b9050614140565b600090505b92915050565b60006141528383613444565b156141955782600001600083815260200190815260200160002060006141789190614522565b61418e8284600101613ffb90919063ffffffff16565b905061419a565b600090505b92915050565b60006141ac8383613464565b156141ce576141c78284600101613ffb90919063ffffffff16565b90506141d3565b600090505b92915050565b60006141e882602001516144ad565b60208001019050919050565b8282820152505050565b6000808390506142218184614212886144ad565b6144bb9092919063ffffffff16565b60208103905060008090505b85518110156142af576142668285888481518110151561424957fe5b90602001906020020151600001516141f49092919063ffffffff16565b60208203915061429c8285888481518110151561427f57fe5b90602001906020020151602001516141f49092919063ffffffff16565b602082039150808060010191505061422d565b50809150509392505050565b60008184600001600085815260200190815260200160002090805190602001906142e692919061456a565b506142fd83856001016134ef90919063ffffffff16565b90509392505050565b60006143106127e3565b9050600073ffffffffffffffffffffffffffffffffffffffff168273ffffffffffffffffffffffffffffffffffffffff1614151515614384576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040161437b90615a3d565b60405180910390fd5b8073ffffffffffffffffffffffffffffffffffffffff168273ffffffffffffffffffffffffffffffffffffffff16141515156143f5576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016143ec906158bd565b60405180910390fd5b8173ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff167fb9f84b8e65164b14439ae3620df0a4d8786d896996c0282b683f9d8c08f046e860405160405180910390a360007f06b7792c761dcc05af1761f0315ce8b01ac39c16cc934eb0b2f7a8e71414f2626001029050828155505050565b600061449782846001016134ef90919063ffffffff16565b905092915050565b600081830151905092915050565b600060408251029050919050565b8282820152505050565b604080519081016040528060008019168152602001606081525090565b604080519081016040528060008019168152602001600080191681525090565b604080519081016040528060008019168152602001600080191681525090565b50805460018160011615610100020316600290046000825580601f106145485750614567565b601f01602090049060005260206000209081019061456691906145ea565b5b50565b828054600181600116156101000203166002900490600052602060002090601f016020900481019282601f106145ab57805160ff19168380011785556145d9565b828001600101855582156145d9579182015b828111156145d85782518255916020019190600101906145bd565b5b5090506145e691906145ea565b5090565b61460c91905b808211156146085760008160009055506001016145f0565b5090565b90565b600061461b8235615dad565b905092915050565b600061462f8235615dbf565b905092915050565b600082601f830112151561464a57600080fd5b813561465d61465882615c84565b615c57565b9150818183526020840193506020810190508385602084028201111561468257600080fd5b60005b838110156146b2578161469888826146d0565b845260208401935060208301925050600181019050614685565b5050505092915050565b60006146c88235615dd1565b905092915050565b60006146dc8235615ddd565b905092915050565b60008083601f84011215156146f857600080fd5b8235905067ffffffffffffffff81111561471157600080fd5b60208301915083600182028301111561472957600080fd5b9250929050565b600061473c8251615de7565b905092915050565b60006147508235615df5565b905092915050565b60006147648251615df5565b905092915050565b60006147788235615dff565b905092915050565b600061478c8251615dff565b905092915050565b6000602082840312156147a657600080fd5b60006147b48482850161460f565b91505092915050565b6000602082840312156147cf57600080fd5b60006147dd84828501614623565b91505092915050565b60008060008060008060008060008060006101208c8e03121561480857600080fd5b60006148168e828f0161460f565b9b505060206148278e828f0161460f565b9a505060408c013567ffffffffffffffff81111561484457600080fd5b6148508e828f016146e4565b995099505060606148638e828f01614744565b97505060806148748e828f01614744565b96505060a06148858e828f01614744565b95505060c06148968e828f01614744565b94505060e08c013567ffffffffffffffff8111156148b357600080fd5b6148bf8e828f016146e4565b93509350506101006148d38e828f01614744565b9150509295989b509295989b9093969950565b6000602082840312156148f857600080fd5b6000614906848285016146d0565b91505092915050565b6000806040838503121561492257600080fd5b6000614930858286016146d0565b9250506020614941858286016146d0565b9150509250929050565b6000806000806080858703121561496157600080fd5b600061496f878288016146d0565b9450506020614980878288016146d0565b9350506040614991878288016146d0565b92505060606149a2878288016146d0565b91505092959194509250565b60008060008060008060c087890312156149c757600080fd5b60006149d589828a016146d0565b96505060206149e689828a016146d0565b95505060406149f789828a016146d0565b9450506060614a0889828a016146d0565b9350506080614a1989828a016146d0565b92505060a0614a2a89828a016146d0565b9150509295509295509295565b600080600080600080600060e0888a031215614a5257600080fd5b6000614a608a828b016146d0565b9750506020614a718a828b016146d0565b9650506040614a828a828b016146d0565b9550506060614a938a828b016146d0565b9450506080614aa48a828b016146d0565b93505060a0614ab58a828b016146d0565b92505060c0614ac68a828b016146d0565b91505092959891949750929550565b600080600080600060a08688031215614aed57600080fd5b6000614afb888289016146d0565b9550506020614b0c888289016146d0565b9450506040614b1d8882890161476c565b935050606086013567ffffffffffffffff811115614b3a57600080fd5b614b4688828901614637565b925050608086013567ffffffffffffffff811115614b6357600080fd5b614b6f88828901614637565b9150509295509295909350565b60008060208385031215614b8f57600080fd5b600083013567ffffffffffffffff811115614ba957600080fd5b614bb5858286016146e4565b92509250509250929050565b600080600080600060808688031215614bd957600080fd5b600086013567ffffffffffffffff811115614bf357600080fd5b614bff888289016146e4565b95509550506020614c12888289016146bc565b9350506040614c2388828901614744565b9250506060614c34888289016146d0565b9150509295509295909350565b600060208284031215614c5357600080fd5b6000614c6184828501614730565b91505092915050565b600060208284031215614c7c57600080fd5b6000614c8a84828501614744565b91505092915050565b600060208284031215614ca557600080fd5b6000614cb384828501614758565b91505092915050565b60008060408385031215614ccf57600080fd5b6000614cdd85828601614744565b9250506020614cee85828601614623565b9150509250929050565b600060208284031215614d0a57600080fd5b6000614d1884828501614780565b91505092915050565b614d2a81615e0c565b82525050565b614d3981615d1e565b82525050565b614d4881615d0c565b82525050565b6000614d5982615cc6565b808452602084019350614d6b83615cac565b60005b82811015614d9d57614d81868351614e13565b614d8a82615cf2565b9150602086019550600181019050614d6e565b50849250505092915050565b6000614db482615cd1565b808452602084019350614dc683615cb9565b60005b82811015614df857614ddc86835161567a565b614de582615cff565b9150604086019550600181019050614dc9565b50849250505092915050565b614e0d81615d30565b82525050565b614e1c81615d3c565b82525050565b614e2b81615d46565b82525050565b6000614e3c82615cdc565b808452614e50816020860160208601615e42565b614e5981615e75565b602085010191505092915050565b6000614e7282615ce7565b808452614e86816020860160208601615e42565b614e8f81615e75565b602085010191505092915050565b6000601c82527f456e636f64696e67204572726f723a206f666673657420213d20302e000000006020830152604082019050919050565b6000602682527f47534e426f756e636572426173653a2063616c6c6572206973206e6f7420526560208301527f6c617948756200000000000000000000000000000000000000000000000000006040830152606082019050919050565b6000601f82527f43616e6e6f742044454c4554452066726f6d2073797374656d207461626c65006020830152604082019050919050565b6000601a82527f43616e6e6f74205550444154452073797374656d207461626c650000000000006020830152604082019050919050565b6000602682527f4f776e61626c653a206e6577206f776e657220697320746865207a65726f206160208301527f64647265737300000000000000000000000000000000000000000000000000006040830152606082019050919050565b6000601f82527f43616e6e6f7420494e5345525420696e746f2073797374656d207461626c65006020830152604082019050919050565b6000602582527f69645461626c654b6579206e6f7420612073756268617368205b69645d2e5b7460208301527f61626c655d0000000000000000000000000000000000000000000000000000006040830152606082019050919050565b6000602b82527f47534e436f6e746578743a206e65772052656c6179487562206973207468652060208301527f63757272656e74206f6e650000000000000000000000000000000000000000006040830152606082019050919050565b6000602e82527f4f6e6c79206f776e65722f64656c65676174652063616e20555044415445206960208301527f6e746f2074686973207461626c650000000000000000000000000000000000006040830152606082019050919050565b6000602082527f4572726f723a206b65792065786973747320696e206f7468657220646963742e6020830152604082019050919050565b6000601582527f726f7720616c726561647920686173206f776e657200000000000000000000006020830152604082019050919050565b6000601082527f4572726f7220616c69676e6d656e742e000000000000000000000000000000006020830152604082019050919050565b6000603982527f4e6f7420726f774f776e6572206f72206f776e65722f64656c6567617465206660208301527f6f722055504441544520696e746f2074686973207461626c65000000000000006040830152606082019050919050565b6000602e82527f4f6e6c79206f776e65722f64656c65676174652063616e20494e53455254206960208301527f6e746f2074686973207461626c650000000000000000000000000000000000006040830152606082019050919050565b6000601282527f6572726f722072656d6f76696e67206b657900000000000000000000000000006020830152604082019050919050565b6000602082527f4f776e61626c653a2063616c6c6572206973206e6f7420746865206f776e65726020830152604082019050919050565b6000602e82527f436f6e747261637420696e7374616e63652068617320616c726561647920626560208301527f656e20696e697469616c697a65640000000000000000000000000000000000006040830152606082019050919050565b6000601782527f69642b6669656c6420616c7265616479206578697374730000000000000000006020830152604082019050919050565b6000602e82527f4f6e6c79206f776e65722f64656c65676174652063616e2044454c455445206660208301527f726f6d2074686973207461626c650000000000000000000000000000000000006040830152606082019050919050565b6000602c82527f47534e436f6e746578743a206e65772052656c6179487562206973207468652060208301527f7a65726f206164647265737300000000000000000000000000000000000000006040830152606082019050919050565b6000601382527f496e76616c6964207461626c65207479706521000000000000000000000000006020830152604082019050919050565b6000601482527f5461626c6520616c7265616479206578697374730000000000000000000000006020830152604082019050919050565b6000601082527f696420646f65736e2774206578697374000000000000000000000000000000006020830152604082019050919050565b6000601182527f7461626c65206e6f7420637265617465640000000000000000000000000000006020830152604082019050919050565b6000601382527f4b657920646f6573206e6f7420657869737421000000000000000000000000006020830152604082019050919050565b6000601c82527f696420646f65736e27742065786973742c2075736520494e53455254000000006020830152604082019050919050565b6000601482527f7461626c6520646f6573206e6f742065786973740000000000000000000000006020830152604082019050919050565b6000601782527f53656e646572206e6f74206f776e6572206f6620726f770000000000000000006020830152604082019050919050565b6000602b82527f6669656c644b6579206e6f7420612073756268617368205b6669656c645d2e5b60208301527f69645d2e5b7461626c655d0000000000000000000000000000000000000000006040830152606082019050919050565b6040820160008201516156906000850182614e13565b5060208201516156a36020850182614e13565b50505050565b60006040830160008301516156c16000860182614e13565b50602083015184820360208601526156d98282614da9565b9150508091505092915050565b6156ef81615d92565b82525050565b6156fe81615d9c565b82525050565b60006020820190506157196000830184614d3f565b92915050565b60006020820190506157346000830184614d21565b92915050565b600060408201905061574f6000830185614d3f565b61575c6020830184614e22565b9392505050565b6000602082019050818103600083015261577d8184614d4e565b905092915050565b600060208201905061579a6000830184614e04565b92915050565b60006020820190506157b56000830184614e13565b92915050565b600060208201905081810360008301526157d58184614e67565b905092915050565b600060208201905081810360008301526157f681614e9d565b9050919050565b6000602082019050818103600083015261581681614ed4565b9050919050565b6000602082019050818103600083015261583681614f31565b9050919050565b6000602082019050818103600083015261585681614f68565b9050919050565b6000602082019050818103600083015261587681614f9f565b9050919050565b6000602082019050818103600083015261589681614ffc565b9050919050565b600060208201905081810360008301526158b681615033565b9050919050565b600060208201905081810360008301526158d681615090565b9050919050565b600060208201905081810360008301526158f6816150ed565b9050919050565b600060208201905081810360008301526159168161514a565b9050919050565b6000602082019050818103600083015261593681615181565b9050919050565b60006020820190508181036000830152615956816151b8565b9050919050565b60006020820190508181036000830152615976816151ef565b9050919050565b600060208201905081810360008301526159968161524c565b9050919050565b600060208201905081810360008301526159b6816152a9565b9050919050565b600060208201905081810360008301526159d6816152e0565b9050919050565b600060208201905081810360008301526159f681615317565b9050919050565b60006020820190508181036000830152615a1681615374565b9050919050565b60006020820190508181036000830152615a36816153ab565b9050919050565b60006020820190508181036000830152615a5681615408565b9050919050565b60006020820190508181036000830152615a7681615465565b9050919050565b60006020820190508181036000830152615a968161549c565b9050919050565b60006020820190508181036000830152615ab6816154d3565b9050919050565b60006020820190508181036000830152615ad68161550a565b9050919050565b60006020820190508181036000830152615af681615541565b9050919050565b60006020820190508181036000830152615b1681615578565b9050919050565b60006020820190508181036000830152615b36816155af565b9050919050565b60006020820190508181036000830152615b56816155e6565b9050919050565b60006020820190508181036000830152615b768161561d565b9050919050565b60006020820190508181036000830152615b9781846156a9565b905092915050565b6000602082019050615bb460008301846156e6565b92915050565b6000604082019050615bcf60008301856156e6565b615bdc6020830184614d3f565b9392505050565b6000604082019050615bf860008301856156e6565b615c056020830184614d30565b9392505050565b6000604082019050615c2160008301856156e6565b8181036020830152615c338184614e31565b90509392505050565b6000602082019050615c5160008301846156f5565b92915050565b6000604051905081810181811067ffffffffffffffff82111715615c7a57600080fd5b8060405250919050565b600067ffffffffffffffff821115615c9b57600080fd5b602082029050602081019050919050565b6000602082019050919050565b6000602082019050919050565b600081519050919050565b600081519050919050565b600081519050919050565b600081519050919050565b6000602082019050919050565b6000602082019050919050565b6000615d1782615d72565b9050919050565b6000615d2982615d72565b9050919050565b60008115159050919050565b6000819050919050565b60007fffffffff0000000000000000000000000000000000000000000000000000000082169050919050565b600073ffffffffffffffffffffffffffffffffffffffff82169050919050565b6000819050919050565b600064ffffffffff82169050919050565b6000615db882615d72565b9050919050565b6000615dca82615d72565b9050919050565b60008115159050919050565b6000819050919050565b600061ffff82169050919050565b6000819050919050565b600060ff82169050919050565b6000615e1782615e1e565b9050919050565b6000615e2982615e30565b9050919050565b6000615e3b82615d72565b9050919050565b60005b83811015615e60578082015181840152602081019050615e45565b83811115615e6f576000848401525b50505050565b6000601f19601f830116905091905056fea265627a7a723058206c40c1fc4f987517983f4c145ead93726cf13a6c0f76a3962cc086bc1c4b82126c6578706572696d656e74616cf50037";
var deployedBytecode = "0x608060405260043610610195576000357c0100000000000000000000000000000000000000000000000000000000900463ffffffff168062f714ce1461019757806301ee810a146101c05780631fd6dda5146101eb578063287e724614610228578063365628a2146102665780633c2e85991461028f5780634102fbf6146102ba57806359cb73a4146102e5578063621d114e146103225780636729003c1461034b578063715018a61461038857806374e861d61461039f57806380274db7146103ca5780638129fc1c1461040757806383947ea01461041e5780638da5cb5b1461045c5780638f32d59b1461048757806392e8aa6b146104b2578063a2ea7c6e146104db578063ad61ccd514610518578063bc41c3dd14610543578063c2309bf91461056c578063c4d66de8146105a9578063d2c5ce31146105d2578063d887f105146105fd578063e06e0e221461063b578063e293d81714610664578063ed90cb371461068d578063f201fe2a146106b6578063f2fde38b146106f3578063fa09e6301461071c578063fc4812f214610759575b005b3480156101a357600080fd5b506101be60048036036101b99190810190614cbc565b610782565b005b3480156101cc57600080fd5b506101d5610864565b6040516101e29190615c3c565b60405180910390f35b3480156101f757600080fd5b50610212600480360361020d91908101906148e6565b61087b565b60405161021f9190615785565b60405180910390f35b34801561023457600080fd5b5061024f600480360361024a91908101906148e6565b610898565b60405161025d92919061573a565b60405180910390f35b34801561027257600080fd5b5061028d60048036036102889190810190614ad5565b6108ee565b005b34801561029b57600080fd5b506102a4610a1a565b6040516102b19190615b9f565b60405180910390f35b3480156102c657600080fd5b506102cf610acd565b6040516102dc91906157a0565b60405180910390f35b3480156102f157600080fd5b5061030c600480360361030791908101906148e6565b610af4565b6040516103199190615b9f565b60405180910390f35b34801561032e57600080fd5b5061034960048036036103449190810190614a37565b610b0c565b005b34801561035757600080fd5b50610372600480360361036d91908101906148e6565b610e35565b60405161037f91906157a0565b60405180910390f35b34801561039457600080fd5b5061039d610e78565b005b3480156103ab57600080fd5b506103b4610f82565b6040516103c19190615704565b60405180910390f35b3480156103d657600080fd5b506103f160048036036103ec9190810190614b7c565b610f91565b6040516103fe91906157a0565b60405180910390f35b34801561041357600080fd5b5061041c61105f565b005b34801561042a57600080fd5b50610445600480360361044091908101906147e6565b611163565b604051610453929190615c0c565b60405180910390f35b34801561046857600080fd5b506104716111e2565b60405161047e9190615704565b60405180910390f35b34801561049357600080fd5b5061049c61120c565b6040516104a99190615785565b60405180910390f35b3480156104be57600080fd5b506104d960048036036104d49190810190614a37565b61126b565b005b3480156104e757600080fd5b5061050260048036036104fd91908101906148e6565b6114cd565b60405161050f9190615b7d565b60405180910390f35b34801561052457600080fd5b5061052d6114fe565b60405161053a91906157bb565b60405180910390f35b34801561054f57600080fd5b5061056a60048036036105659190810190614c6a565b61153b565b005b34801561057857600080fd5b50610593600480360361058e91908101906148e6565b6115aa565b6040516105a09190615763565b60405180910390f35b3480156105b557600080fd5b506105d060048036036105cb9190810190614794565b611623565b005b3480156105de57600080fd5b506105e76117cd565b6040516105f49190615704565b60405180910390f35b34801561060957600080fd5b50610624600480360361061f91908101906148e6565b6117e5565b604051610632929190615bba565b60405180910390f35b34801561064757600080fd5b50610662600480360361065d9190810190614bc1565b61187a565b005b34801561067057600080fd5b5061068b6004803603610686919081019061494b565b611948565b005b34801561069957600080fd5b506106b460048036036106af919081019061490f565b611c16565b005b3480156106c257600080fd5b506106dd60048036036106d8919081019061490f565b611cb2565b6040516106ea9190615785565b60405180910390f35b3480156106ff57600080fd5b5061071a60048036036107159190810190614794565b611cd2565b005b34801561072857600080fd5b50610743600480360361073e91908101906147bd565b611d27565b6040516107509190615b9f565b60405180910390f35b34801561076557600080fd5b50610780600480360361077b91908101906149ae565b611ec0565b005b61078a61120c565b15156107cb576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016107c2906159bd565b60405180910390fd5b60006107d561222e565b90508073ffffffffffffffffffffffffffffffffffffffff1662f714ce84846040518363ffffffff167c010000000000000000000000000000000000000000000000000000000002815260040161082d929190615be3565b600060405180830381600087803b15801561084757600080fd5b505af115801561085b573d6000803e3d6000fd5b50505050505050565b606860009054906101000a900464ffffffffff1681565b600061089182606d61223d90919063ffffffff16565b9050919050565b60008060006108b184606d6122b490919063ffffffff16565b600190049050807c0100000000000000000000000000000000000000000000000000000000029150602081908060020a8204915050925050915091565b6108f661120c565b1515610937576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040161092e906159bd565b60405180910390fd5b60006001026069600086815260200190815260200160002054141515610992576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040161098990615a7d565b60405180910390fd5b60008090506109a28585836122d4565b6109db7f736368656d61732e7075626c69632e7461626c6573000000000000000000000060010287606d6123809092919063ffffffff16565b506109f085606a6124ab90919063ffffffff16565b506109f96144c5565b610a048785856124cb565b9050610a108682612548565b5050505050505050565b6000610a2461222e565b73ffffffffffffffffffffffffffffffffffffffff166370a08231306040518263ffffffff167c0100000000000000000000000000000000000000000000000000000000028152600401610a78919061571f565b60206040518083038186803b158015610a9057600080fd5b505afa158015610aa4573d6000803e3d6000fd5b505050506040513d601f19601f82011682018060405250610ac89190810190614c93565b905090565b7f736368656d61732e7075626c69632e7461626c6573000000000000000000000060010281565b60676020528060005260406000206000915090505481565b868487600080610b1b856117e5565b91509150600082111515610b64576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401610b5b9061583d565b60405180910390fd5b6001821180610b7e575060011515610b7a61120c565b1515145b80610bbb5750610b8c612576565b73ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff16145b1515610bfc576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401610bf3906158dd565b60405180910390fd5b60011515610c0b8587866125ca565b1515141515610c4f576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401610c469061589d565b60405180910390fd5b600282101515610d57576000610c6f84606d6122b490919063ffffffff16565b9050600060208260019004908060020a82049150509050610c8e612576565b73ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff161415610cc657610d54565b60011515610cd261120c565b15151480610d125750610ce3612576565b73ffffffffffffffffffffffffffffffffffffffff168373ffffffffffffffffffffffffffffffffffffffff16145b1515610d53576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401610d4a9061595d565b60405180910390fd5b5b50505b60011515610d718d89606a61262a9092919063ffffffff16565b1515141515610db5576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401610dac90615afd565b60405180910390fd5b60011515610dc4898d8d6125ca565b1515141515610e08576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401610dff90615b5d565b60405180910390fd5b610e10612675565b610e268a87606d6126b89092919063ffffffff16565b50505050505050505050505050565b6000610e4b82606d61223d90919063ffffffff16565b15610e6b57610e6482606d6122b490919063ffffffff16565b9050610e73565b600060010290505b919050565b610e8061120c565b1515610ec1576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401610eb8906159bd565b60405180910390fd5b600073ffffffffffffffffffffffffffffffffffffffff16603360009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff167f8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e060405160405180910390a36000603360006101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff160217905550565b6000610f8c6127e3565b905090565b6000610f9b610f82565b73ffffffffffffffffffffffffffffffffffffffff163373ffffffffffffffffffffffffffffffffffffffff1614151561100a576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401611001906157fd565b60405180910390fd5b61105783838080601f016020809104026020016040519081016040528093929190818152602001838380828437600081840152601f19601f82011690508083019250505050505050612814565b905092915050565b600060019054906101000a900460ff168061107e575061107d61281b565b5b8061109557506000809054906101000a900460ff16155b15156110d6576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016110cd906159dd565b60405180910390fd5b60008060019054906101000a900460ff161590508015611126576001600060016101000a81548160ff02191690831515021790555060016000806101000a81548160ff0219169083151502179055505b61112f33611623565b611137612832565b61113f612925565b80156111605760008060016101000a81548160ff0219169083151502179055505b50565b600060606000611171612987565b9050600060676000838152602001908152602001600020549050606860009054906101000a900464ffffffffff1664ffffffffff16811015156111c3576111b86002612c42565b9350935050506111d2565b6111cb612c64565b9350935050505b9b509b9950505050505050505050565b6000603360009054906101000a900473ffffffffffffffffffffffffffffffffffffffff16905090565b6000603360009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff1661124f612576565b73ffffffffffffffffffffffffffffffffffffffff1614905090565b86848760008061127a856117e5565b915091506000821115156112c3576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016112ba9061587d565b60405180910390fd5b60018211806112dd5750600115156112d961120c565b1515145b8061131a57506112eb612576565b73ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff16145b151561135b576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016113529061597d565b60405180910390fd5b6001151561136a8587866125ca565b15151415156113ae576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016113a59061589d565b60405180910390fd5b600015156113c68b606d61223d90919063ffffffff16565b151514151561140a576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401611401906159fd565b60405180910390fd5b60011515611419898d8d6125ca565b151514151561145d576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040161145490615b5d565b60405180910390fd5b611465612675565b61147b8c88606a612c899092919063ffffffff16565b50600015156114948c606d61223d90919063ffffffff16565b151514156114a8576114a78b888e612cd4565b5b6114be8a87606d6126b89092919063ffffffff16565b50505050505050505050505050565b6114d56144c5565b60606114eb83606d61307690919063ffffffff16565b90506114f681613096565b915050919050565b60606040805190810160405280600581526020017f312e302e30000000000000000000000000000000000000000000000000000000815250905090565b61154361120c565b1515611584576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040161157b906159bd565b60405180910390fd5b80606860006101000a81548164ffffffffff021916908364ffffffffff16021790555050565b6060600115156115c483606a61313f90919063ffffffff16565b1515141515611608576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016115ff90615abd565b60405180910390fd5b61161c82606a61315f90919063ffffffff16565b9050919050565b600060019054906101000a900460ff1680611642575061164161281b565b5b8061165957506000809054906101000a900460ff16155b151561169a576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401611691906159dd565b60405180910390fd5b60008060019054906101000a900460ff1615905080156116ea576001600060016101000a81548160ff02191690831515021790555060016000806101000a81548160ff0219169083151502179055505b81603360006101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff160217905550603360009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16600073ffffffffffffffffffffffffffffffffffffffff167f8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e060405160405180910390a380156117c95760008060016101000a81548160ff0219169083151502179055505b5050565b73edb211a2dbbde62012440177e65b68e0a66e453181565b60008060006001026069600085815260200190815260200160002054111515611843576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040161183a90615b1d565b60405180910390fd5b600060696000858152602001908152602001600020546001900490508060ff169250600881908060020a8204915050915050915091565b611882610f82565b73ffffffffffffffffffffffffffffffffffffffff163373ffffffffffffffffffffffffffffffffffffffff161415156118f1576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016118e8906157fd565b60405180910390fd5b61194185858080601f016020809104026020016040519081016040528093929190818152602001838380828437600081840152601f19601f820116905080830192505050505050508484846131ce565b5050505050565b83838383600115156119668583606a61262a9092919063ffffffff16565b15151415156119aa576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016119a190615a9d565b60405180910390fd5b6000806119b6866117e5565b915091506000821115156119ff576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016119f69061581d565b60405180910390fd5b6001821180611a19575060011515611a1561120c565b1515145b80611a565750611a27612576565b73ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff16145b1515611a97576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401611a8e90615a1d565b60405180910390fd5b60011515611aa68588886125ca565b1515141515611aea576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401611ae19061589d565b60405180910390fd5b600282101515611beb57611afc61120c565b80611b395750611b0a612576565b73ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff16145b15611b4357611bea565b6000611b5986606d6122b490919063ffffffff16565b9050600060208260019004908060020a82049150509050611b78612576565b73ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff16141515611be7576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401611bde90615b3d565b60405180910390fd5b50505b5b611bf3612675565b611c098a88606a6131d49092919063ffffffff16565b5050505050505050505050565b611c1e61120c565b1515611c5f576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401611c56906159bd565b60405180910390fd5b611c987f736368656d61732e7075626c69632e7461626c6573000000000000000000000060010283606d61321f9092919063ffffffff16565b50611cad81606a61324290919063ffffffff16565b505050565b6000611cca8383606a61262a9092919063ffffffff16565b905092915050565b611cda61120c565b1515611d1b576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401611d12906159bd565b60405180910390fd5b611d248161327b565b50565b6000611d3161120c565b1515611d72576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401611d69906159bd565b60405180910390fd5b6000611d7c61222e565b90506000611d8861222e565b73ffffffffffffffffffffffffffffffffffffffff166370a08231306040518263ffffffff167c0100000000000000000000000000000000000000000000000000000000028152600401611ddc919061571f565b60206040518083038186803b158015611df457600080fd5b505afa158015611e08573d6000803e3d6000fd5b505050506040513d601f19601f82011682018060405250611e2c9190810190614c93565b90508173ffffffffffffffffffffffffffffffffffffffff1662f714ce82866040518363ffffffff167c0100000000000000000000000000000000000000000000000000000000028152600401611e84929190615be3565b600060405180830381600087803b158015611e9e57600080fd5b505af1158015611eb2573d6000803e3d6000fd5b505050508092505050919050565b8585858560011515611ede8583606a61262a9092919063ffffffff16565b1515141515611f22576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401611f1990615a9d565b60405180910390fd5b600080611f2e866117e5565b91509150600082111515611f77576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401611f6e9061581d565b60405180910390fd5b6001821180611f91575060011515611f8d61120c565b1515145b80611fce5750611f9f612576565b73ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff16145b151561200f576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040161200690615a1d565b60405180910390fd5b6001151561201e8588886125ca565b1515141515612062576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016120599061589d565b60405180910390fd5b6002821015156121635761207461120c565b806120b15750612082612576565b73ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff16145b156120bb57612162565b60006120d186606d6122b490919063ffffffff16565b9050600060208260019004908060020a820491505090506120f0612576565b73ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff1614151561215f576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040161215690615b3d565b60405180910390fd5b50505b5b60011515612172898d8a6125ca565b15151415156121b6576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016121ad90615b5d565b60405180910390fd5b6121be612675565b60006121d488606d6133ad90919063ffffffff16565b90506001151581151514151561221f576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016122169061599d565b60405180910390fd5b50505050505050505050505050565b60006122386127e3565b905090565b6000612255828460000161342490919063ffffffff16565b806122725750612271828460030161344490919063ffffffff16565b5b8061228f575061228e828460060161313f90919063ffffffff16565b5b806122ac57506122ab828460090161346490919063ffffffff16565b5b905092915050565b60006122cc828460000161348490919063ffffffff16565b905092915050565b6122dc61120c565b151561231d576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401612314906159bd565b60405180910390fd5b60008260ff168117905060088273ffffffffffffffffffffffffffffffffffffffff169060020a0273ffffffffffffffffffffffffffffffffffffffff168117905080600102606960008681526020019081526020016000208190555050505050565b6000612398838560000161342490919063ffffffff16565b1515156123da576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016123d1906158fd565b60405180910390fd5b6123f0838560030161344490919063ffffffff16565b151515612432576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401612429906158fd565b60405180910390fd5b612448838560090161346490919063ffffffff16565b15151561248a576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401612481906158fd565b60405180910390fd5b6124a2838386600601612c899092919063ffffffff16565b90509392505050565b60006124c382846001016134ef90919063ffffffff16565b905092915050565b6124d36144c5565b81518351141515612519576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016125109061593d565b60405180910390fd5b6125216144c5565b84816000018181525050612535848461355b565b8160200181905250809150509392505050565b6000606061255583613671565b905061256d8482606d6137419092919063ffffffff16565b91505092915050565b60006125806127e3565b73ffffffffffffffffffffffffffffffffffffffff163373ffffffffffffffffffffffffffffffffffffffff161415156125bc573390506125c7565b6125c461386c565b90505b90565b60006060604080519080825280601f01601f1916602001820160405280156126015781602001600182028038833980820191505090505b509050846040820152836020820152600081805190602001209050838114925050509392505050565b6000612636848461313f565b1561266957612662828560000160008681526020019081526020016000206138e490919063ffffffff16565b905061266e565b600090505b9392505050565b600061267f612987565b90506000606760008381526020019081526020016000205490506001810160676000848152602001908152602001600020819055505050565b60006126d0838560030161344490919063ffffffff16565b151515612712576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401612709906158fd565b60405180910390fd5b612728838560060161313f90919063ffffffff16565b15151561276a576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401612761906158fd565b60405180910390fd5b612780838560090161346490919063ffffffff16565b1515156127c2576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016127b9906158fd565b60405180910390fd5b6127da8383866000016139079092919063ffffffff16565b90509392505050565b6000807f06b7792c761dcc05af1761f0315ce8b01ac39c16cc934eb0b2f7a8e71414f2626001029050805491505090565b6000919050565b6000803090506000813b9050600081149250505090565b600060019054906101000a900460ff1680612851575061285061281b565b5b8061286857506000809054906101000a900460ff16155b15156128a9576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016128a0906159dd565b60405180910390fd5b60008060019054906101000a900460ff1615905080156128f9576001600060016101000a81548160ff02191690831515021790555060016000806101000a81548160ff0219169083151502179055505b612901613942565b80156129225760008060016101000a81548160ff0219169083151502179055505b50565b6103e8606860006101000a81548164ffffffffff021916908364ffffffffff1602179055506129847f736368656d61732e7075626c69632e7461626c657300000000000000000000006001026000606d613a4a9092919063ffffffff16565b50565b6000806000606660009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff166392d66313426040518263ffffffff167c0100000000000000000000000000000000000000000000000000000000028152600401612a039190615b9f565b60206040518083038186803b158015612a1b57600080fd5b505afa158015612a2f573d6000803e3d6000fd5b505050506040513d601f19601f82011682018060405250612a539190810190614c41565b90506000606660009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff1663a324ad24426040518263ffffffff167c0100000000000000000000000000000000000000000000000000000000028152600401612ace9190615b9f565b60206040518083038186803b158015612ae657600080fd5b505afa158015612afa573d6000803e3d6000fd5b505050506040513d601f19601f82011682018060405250612b1e9190810190614cf8565b90506000606660009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff166365c72840426040518263ffffffff167c0100000000000000000000000000000000000000000000000000000000028152600401612b999190615b9f565b60206040518083038186803b158015612bb157600080fd5b505afa158015612bc5573d6000803e3d6000fd5b505050506040513d601f19601f82011682018060405250612be99190810190614cf8565b90508261ffff168417935060108260ff169060020a028417935060188160ff169060020a028417935083604051602001808281526020019150506040516020818303038152906040528051906020012094505050505090565b6000606082600b01602060405190810160405280600081525091509150915091565b60006060612c816020604051908101604052806000815250613d32565b915091509091565b6000612c95848461313f565b15612cc857612cc1828560000160008681526020019081526020016000206134ef90919063ffffffff16565b9050612ccd565b600090505b9392505050565b60001515612cec84606d61223d90919063ffffffff16565b1515141515612d30576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401612d279061591d565b60405180910390fd5b600080606660009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff166392d66313426040518263ffffffff167c0100000000000000000000000000000000000000000000000000000000028152600401612daa9190615b9f565b60206040518083038186803b158015612dc257600080fd5b505afa158015612dd6573d6000803e3d6000fd5b505050506040513d601f19601f82011682018060405250612dfa9190810190614c41565b90506000606660009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff1663a324ad24426040518263ffffffff167c0100000000000000000000000000000000000000000000000000000000028152600401612e759190615b9f565b60206040518083038186803b158015612e8d57600080fd5b505afa158015612ea1573d6000803e3d6000fd5b505050506040513d601f19601f82011682018060405250612ec59190810190614cf8565b90506000606660009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff166365c72840426040518263ffffffff167c0100000000000000000000000000000000000000000000000000000000028152600401612f409190615b9f565b60206040518083038186803b158015612f5857600080fd5b505afa158015612f6c573d6000803e3d6000fd5b505050506040513d601f19601f82011682018060405250612f909190810190614cf8565b90508261ffff168417935060108260ff169060020a028417935060188160ff169060020a02841793506000847c01000000000000000000000000000000000000000000000000000000000290506020612fe7612576565b73ffffffffffffffffffffffffffffffffffffffff169060020a028517945061301f8886600102606d6126b89092919063ffffffff16565b50613028612576565b73ffffffffffffffffffffffffffffffffffffffff1686887fc3b047ab84cb81685163ad3ef7de856809a7d1cd6d900310242d6c3dca034bc160405160405180910390a45050505050505050565b606061308e8284600301613d4290919063ffffffff16565b905092915050565b61309e6144c5565b6000825190506130ac6144c5565b6130bf8285613e4590919063ffffffff16565b8160000181815250506020820391506130e18285613e5390919063ffffffff16565b819150826020018194508290525050600082141515613135576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040161312c906157dd565b60405180910390fd5b8092505050919050565b600061315782846001016138e490919063ffffffff16565b905092915050565b606061316b838361313f565b156131945761318d836000016000848152602001908152602001600020613f5e565b90506131c8565b60006040519080825280602002602001820160405280156131c45781602001602082028038833980820191505090505b5090505b92915050565b50505050565b60006131e0848461313f565b156132135761320c82856000016000868152602001908152602001600020613ffb90919063ffffffff16565b9050613218565b600090505b9392505050565b60006132398383866006016131d49092919063ffffffff16565b90509392505050565b600061324e838361313f565b15613270576132698284600101613ffb90919063ffffffff16565b9050613275565b600090505b92915050565b600073ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff16141515156132ed576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016132e49061585d565b60405180910390fd5b8073ffffffffffffffffffffffffffffffffffffffff16603360009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff167f8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e060405160405180910390a380603360006101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff16021790555050565b60006133c582846000016140f490919063ffffffff16565b806133e257506133e1828460030161414690919063ffffffff16565b5b806133ff57506133fe828460060161324290919063ffffffff16565b5b8061341c575061341b82846009016141a090919063ffffffff16565b5b905092915050565b600061343c82846001016138e490919063ffffffff16565b905092915050565b600061345c82846001016138e490919063ffffffff16565b905092915050565b600061347c82846001016138e490919063ffffffff16565b905092915050565b60006134908383613424565b15156134d1576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016134c890615add565b60405180910390fd5b82600001600083815260200190815260200160002054905092915050565b60006134fb83836138e4565b1515613550578260010182908060018154018082558091505090600182039060005260206000200160009091929091909150558360000160008481526020019081526020016000208190555060019050613555565b600090505b92915050565b6060815183511415156135a3576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040161359a9061593d565b60405180910390fd5b606083516040519080825280602002602001820160405280156135e057816020015b6135cd6144e2565b8152602001906001900390816135c55790505b50905060008090505b8451811015613666576135fa614502565b858281518110151561360857fe5b90602001906020020151816000018181525050848281518110151561362957fe5b9060200190602002015181602001818152505080838381518110151561364b57fe5b906020019060200201819052505080806001019150506135e9565b508091505092915050565b6060600061367e836141d9565b90506060816040519080825280601f01601f1916602001820160405280156136b55781602001600182028038833980820191505090505b5090506136d1828286600001516141f49092919063ffffffff16565b6020820391506136f0828286602001516141fe9092919063ffffffff16565b9150600082141515613737576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040161372e906157dd565b60405180910390fd5b8092505050919050565b6000613759838560000161342490919063ffffffff16565b15151561379b576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401613792906158fd565b60405180910390fd5b6137b1838560060161313f90919063ffffffff16565b1515156137f3576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016137ea906158fd565b60405180910390fd5b613809838560090161346490919063ffffffff16565b15151561384b576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401613842906158fd565b60405180910390fd5b6138638383866003016142bb9092919063ffffffff16565b90509392505050565b600060606000368080601f016020809104026020016040519081016040528093929190818152602001838380828437600081840152601f19601f820116905080830192505050505050509050600080369050905073ffffffffffffffffffffffffffffffffffffffff81830151169250829250505090565b600080836000016000848152602001908152602001600020541415905092915050565b6000818460000160008581526020019081526020016000208190555061393983856001016134ef90919063ffffffff16565b90509392505050565b600060019054906101000a900460ff1680613961575061396061281b565b5b8061397857506000809054906101000a900460ff16155b15156139b9576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016139b0906159dd565b60405180910390fd5b60008060019054906101000a900460ff161590508015613a09576001600060016101000a81548160ff02191690831515021790555060016000806101000a81548160ff0219169083151502179055505b613a26732eda8d1a61824dfa812c4bd139081b9bcb972a6d614306565b8015613a475760008060016101000a81548160ff0219169083151502179055505b50565b60006004826003811115613a5a57fe5b60ff16101515613a9f576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401613a9690615a5d565b60405180910390fd5b613ab5838560000161342490919063ffffffff16565b151515613af7576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401613aee906158fd565b60405180910390fd5b613b0d838560030161344490919063ffffffff16565b151515613b4f576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401613b46906158fd565b60405180910390fd5b613b65838560060161313f90919063ffffffff16565b151515613ba7576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401613b9e906158fd565b60405180910390fd5b613bbd838560090161346490919063ffffffff16565b151515613bff576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401613bf6906158fd565b60405180910390fd5b816003811115613c0b57fe5b60006003811115613c1857fe5b1415613c3b57613c3483856006016124ab90919063ffffffff16565b9050613d2b565b816003811115613c4757fe5b60016003811115613c5457fe5b1415613c7757613c70838560090161447f90919063ffffffff16565b9050613d2b565b816003811115613c8357fe5b60026003811115613c9057fe5b1415613cb957613cb2836000600102866000016139079092919063ffffffff16565b9050613d2b565b816003811115613cc557fe5b600380811115613cd157fe5b1415613d2a57613d238360006040519080825280601f01601f191660200182016040528015613d0f5781602001600182028038833980820191505090505b50866003016142bb9092919063ffffffff16565b9050613d2b565b5b9392505050565b6000606060008391509150915091565b6060613d4e8383613444565b1515613d8f576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401613d8690615add565b60405180910390fd5b8260000160008381526020019081526020016000208054600181600116156101000203166002900480601f016020809104026020016040519081016040528092919081815260200182805460018160011615610100020316600290048015613e385780601f10613e0d57610100808354040283529160200191613e38565b820191906000526020600020905b815481529060010190602001808311613e1b57829003601f168201915b5050505050905092915050565b600081830151905092915050565b60606000808390506000613e70828761449f90919063ffffffff16565b90506020820391506000604082811515613e8657fe5b049050606081604051908082528060200260200182016040528015613ec557816020015b613eb26144e2565b815260200190600190039081613eaa5790505b50905060008090505b82811015613f4c57613ede614502565b613ef1868b613e4590919063ffffffff16565b816000018181525050602086039550613f13868b613e4590919063ffffffff16565b816020018181525050602086039550808383815181101515613f3157fe5b90602001906020020181905250508080600101915050613ece565b50808495509550505050509250929050565b6060808260010180549050604051908082528060200260200182016040528015613f975781602001602082028038833980820191505090505b50905060005b8360010180549050811015613ff1578360010181815481101515613fbd57fe5b90600052602060002001548282815181101515613fd657fe5b90602001906020020181815250508080600101915050613f9d565b5080915050919050565b600061400783836138e4565b156140e957600060018460000160008581526020019081526020016000205403905060006001856001018054905003905081811415156140a0576000856001018281548110151561405457fe5b9060005260206000200154905080866001018481548110151561407357fe5b90600052602060002001819055506001830186600001600083815260200190815260200160002081905550505b846000016000858152602001908152602001600020600090558460010180548015156140c857fe5b600190038181906000526020600020016000905590556001925050506140ee565b600090505b92915050565b60006141008383613424565b1561413b57826000016000838152602001908152602001600020600090556141348284600101613ffb90919063ffffffff16565b9050614140565b600090505b92915050565b60006141528383613444565b156141955782600001600083815260200190815260200160002060006141789190614522565b61418e8284600101613ffb90919063ffffffff16565b905061419a565b600090505b92915050565b60006141ac8383613464565b156141ce576141c78284600101613ffb90919063ffffffff16565b90506141d3565b600090505b92915050565b60006141e882602001516144ad565b60208001019050919050565b8282820152505050565b6000808390506142218184614212886144ad565b6144bb9092919063ffffffff16565b60208103905060008090505b85518110156142af576142668285888481518110151561424957fe5b90602001906020020151600001516141f49092919063ffffffff16565b60208203915061429c8285888481518110151561427f57fe5b90602001906020020151602001516141f49092919063ffffffff16565b602082039150808060010191505061422d565b50809150509392505050565b60008184600001600085815260200190815260200160002090805190602001906142e692919061456a565b506142fd83856001016134ef90919063ffffffff16565b90509392505050565b60006143106127e3565b9050600073ffffffffffffffffffffffffffffffffffffffff168273ffffffffffffffffffffffffffffffffffffffff1614151515614384576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040161437b90615a3d565b60405180910390fd5b8073ffffffffffffffffffffffffffffffffffffffff168273ffffffffffffffffffffffffffffffffffffffff16141515156143f5576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016143ec906158bd565b60405180910390fd5b8173ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff167fb9f84b8e65164b14439ae3620df0a4d8786d896996c0282b683f9d8c08f046e860405160405180910390a360007f06b7792c761dcc05af1761f0315ce8b01ac39c16cc934eb0b2f7a8e71414f2626001029050828155505050565b600061449782846001016134ef90919063ffffffff16565b905092915050565b600081830151905092915050565b600060408251029050919050565b8282820152505050565b604080519081016040528060008019168152602001606081525090565b604080519081016040528060008019168152602001600080191681525090565b604080519081016040528060008019168152602001600080191681525090565b50805460018160011615610100020316600290046000825580601f106145485750614567565b601f01602090049060005260206000209081019061456691906145ea565b5b50565b828054600181600116156101000203166002900490600052602060002090601f016020900481019282601f106145ab57805160ff19168380011785556145d9565b828001600101855582156145d9579182015b828111156145d85782518255916020019190600101906145bd565b5b5090506145e691906145ea565b5090565b61460c91905b808211156146085760008160009055506001016145f0565b5090565b90565b600061461b8235615dad565b905092915050565b600061462f8235615dbf565b905092915050565b600082601f830112151561464a57600080fd5b813561465d61465882615c84565b615c57565b9150818183526020840193506020810190508385602084028201111561468257600080fd5b60005b838110156146b2578161469888826146d0565b845260208401935060208301925050600181019050614685565b5050505092915050565b60006146c88235615dd1565b905092915050565b60006146dc8235615ddd565b905092915050565b60008083601f84011215156146f857600080fd5b8235905067ffffffffffffffff81111561471157600080fd5b60208301915083600182028301111561472957600080fd5b9250929050565b600061473c8251615de7565b905092915050565b60006147508235615df5565b905092915050565b60006147648251615df5565b905092915050565b60006147788235615dff565b905092915050565b600061478c8251615dff565b905092915050565b6000602082840312156147a657600080fd5b60006147b48482850161460f565b91505092915050565b6000602082840312156147cf57600080fd5b60006147dd84828501614623565b91505092915050565b60008060008060008060008060008060006101208c8e03121561480857600080fd5b60006148168e828f0161460f565b9b505060206148278e828f0161460f565b9a505060408c013567ffffffffffffffff81111561484457600080fd5b6148508e828f016146e4565b995099505060606148638e828f01614744565b97505060806148748e828f01614744565b96505060a06148858e828f01614744565b95505060c06148968e828f01614744565b94505060e08c013567ffffffffffffffff8111156148b357600080fd5b6148bf8e828f016146e4565b93509350506101006148d38e828f01614744565b9150509295989b509295989b9093969950565b6000602082840312156148f857600080fd5b6000614906848285016146d0565b91505092915050565b6000806040838503121561492257600080fd5b6000614930858286016146d0565b9250506020614941858286016146d0565b9150509250929050565b6000806000806080858703121561496157600080fd5b600061496f878288016146d0565b9450506020614980878288016146d0565b9350506040614991878288016146d0565b92505060606149a2878288016146d0565b91505092959194509250565b60008060008060008060c087890312156149c757600080fd5b60006149d589828a016146d0565b96505060206149e689828a016146d0565b95505060406149f789828a016146d0565b9450506060614a0889828a016146d0565b9350506080614a1989828a016146d0565b92505060a0614a2a89828a016146d0565b9150509295509295509295565b600080600080600080600060e0888a031215614a5257600080fd5b6000614a608a828b016146d0565b9750506020614a718a828b016146d0565b9650506040614a828a828b016146d0565b9550506060614a938a828b016146d0565b9450506080614aa48a828b016146d0565b93505060a0614ab58a828b016146d0565b92505060c0614ac68a828b016146d0565b91505092959891949750929550565b600080600080600060a08688031215614aed57600080fd5b6000614afb888289016146d0565b9550506020614b0c888289016146d0565b9450506040614b1d8882890161476c565b935050606086013567ffffffffffffffff811115614b3a57600080fd5b614b4688828901614637565b925050608086013567ffffffffffffffff811115614b6357600080fd5b614b6f88828901614637565b9150509295509295909350565b60008060208385031215614b8f57600080fd5b600083013567ffffffffffffffff811115614ba957600080fd5b614bb5858286016146e4565b92509250509250929050565b600080600080600060808688031215614bd957600080fd5b600086013567ffffffffffffffff811115614bf357600080fd5b614bff888289016146e4565b95509550506020614c12888289016146bc565b9350506040614c2388828901614744565b9250506060614c34888289016146d0565b9150509295509295909350565b600060208284031215614c5357600080fd5b6000614c6184828501614730565b91505092915050565b600060208284031215614c7c57600080fd5b6000614c8a84828501614744565b91505092915050565b600060208284031215614ca557600080fd5b6000614cb384828501614758565b91505092915050565b60008060408385031215614ccf57600080fd5b6000614cdd85828601614744565b9250506020614cee85828601614623565b9150509250929050565b600060208284031215614d0a57600080fd5b6000614d1884828501614780565b91505092915050565b614d2a81615e0c565b82525050565b614d3981615d1e565b82525050565b614d4881615d0c565b82525050565b6000614d5982615cc6565b808452602084019350614d6b83615cac565b60005b82811015614d9d57614d81868351614e13565b614d8a82615cf2565b9150602086019550600181019050614d6e565b50849250505092915050565b6000614db482615cd1565b808452602084019350614dc683615cb9565b60005b82811015614df857614ddc86835161567a565b614de582615cff565b9150604086019550600181019050614dc9565b50849250505092915050565b614e0d81615d30565b82525050565b614e1c81615d3c565b82525050565b614e2b81615d46565b82525050565b6000614e3c82615cdc565b808452614e50816020860160208601615e42565b614e5981615e75565b602085010191505092915050565b6000614e7282615ce7565b808452614e86816020860160208601615e42565b614e8f81615e75565b602085010191505092915050565b6000601c82527f456e636f64696e67204572726f723a206f666673657420213d20302e000000006020830152604082019050919050565b6000602682527f47534e426f756e636572426173653a2063616c6c6572206973206e6f7420526560208301527f6c617948756200000000000000000000000000000000000000000000000000006040830152606082019050919050565b6000601f82527f43616e6e6f742044454c4554452066726f6d2073797374656d207461626c65006020830152604082019050919050565b6000601a82527f43616e6e6f74205550444154452073797374656d207461626c650000000000006020830152604082019050919050565b6000602682527f4f776e61626c653a206e6577206f776e657220697320746865207a65726f206160208301527f64647265737300000000000000000000000000000000000000000000000000006040830152606082019050919050565b6000601f82527f43616e6e6f7420494e5345525420696e746f2073797374656d207461626c65006020830152604082019050919050565b6000602582527f69645461626c654b6579206e6f7420612073756268617368205b69645d2e5b7460208301527f61626c655d0000000000000000000000000000000000000000000000000000006040830152606082019050919050565b6000602b82527f47534e436f6e746578743a206e65772052656c6179487562206973207468652060208301527f63757272656e74206f6e650000000000000000000000000000000000000000006040830152606082019050919050565b6000602e82527f4f6e6c79206f776e65722f64656c65676174652063616e20555044415445206960208301527f6e746f2074686973207461626c650000000000000000000000000000000000006040830152606082019050919050565b6000602082527f4572726f723a206b65792065786973747320696e206f7468657220646963742e6020830152604082019050919050565b6000601582527f726f7720616c726561647920686173206f776e657200000000000000000000006020830152604082019050919050565b6000601082527f4572726f7220616c69676e6d656e742e000000000000000000000000000000006020830152604082019050919050565b6000603982527f4e6f7420726f774f776e6572206f72206f776e65722f64656c6567617465206660208301527f6f722055504441544520696e746f2074686973207461626c65000000000000006040830152606082019050919050565b6000602e82527f4f6e6c79206f776e65722f64656c65676174652063616e20494e53455254206960208301527f6e746f2074686973207461626c650000000000000000000000000000000000006040830152606082019050919050565b6000601282527f6572726f722072656d6f76696e67206b657900000000000000000000000000006020830152604082019050919050565b6000602082527f4f776e61626c653a2063616c6c6572206973206e6f7420746865206f776e65726020830152604082019050919050565b6000602e82527f436f6e747261637420696e7374616e63652068617320616c726561647920626560208301527f656e20696e697469616c697a65640000000000000000000000000000000000006040830152606082019050919050565b6000601782527f69642b6669656c6420616c7265616479206578697374730000000000000000006020830152604082019050919050565b6000602e82527f4f6e6c79206f776e65722f64656c65676174652063616e2044454c455445206660208301527f726f6d2074686973207461626c650000000000000000000000000000000000006040830152606082019050919050565b6000602c82527f47534e436f6e746578743a206e65772052656c6179487562206973207468652060208301527f7a65726f206164647265737300000000000000000000000000000000000000006040830152606082019050919050565b6000601382527f496e76616c6964207461626c65207479706521000000000000000000000000006020830152604082019050919050565b6000601482527f5461626c6520616c7265616479206578697374730000000000000000000000006020830152604082019050919050565b6000601082527f696420646f65736e2774206578697374000000000000000000000000000000006020830152604082019050919050565b6000601182527f7461626c65206e6f7420637265617465640000000000000000000000000000006020830152604082019050919050565b6000601382527f4b657920646f6573206e6f7420657869737421000000000000000000000000006020830152604082019050919050565b6000601c82527f696420646f65736e27742065786973742c2075736520494e53455254000000006020830152604082019050919050565b6000601482527f7461626c6520646f6573206e6f742065786973740000000000000000000000006020830152604082019050919050565b6000601782527f53656e646572206e6f74206f776e6572206f6620726f770000000000000000006020830152604082019050919050565b6000602b82527f6669656c644b6579206e6f7420612073756268617368205b6669656c645d2e5b60208301527f69645d2e5b7461626c655d0000000000000000000000000000000000000000006040830152606082019050919050565b6040820160008201516156906000850182614e13565b5060208201516156a36020850182614e13565b50505050565b60006040830160008301516156c16000860182614e13565b50602083015184820360208601526156d98282614da9565b9150508091505092915050565b6156ef81615d92565b82525050565b6156fe81615d9c565b82525050565b60006020820190506157196000830184614d3f565b92915050565b60006020820190506157346000830184614d21565b92915050565b600060408201905061574f6000830185614d3f565b61575c6020830184614e22565b9392505050565b6000602082019050818103600083015261577d8184614d4e565b905092915050565b600060208201905061579a6000830184614e04565b92915050565b60006020820190506157b56000830184614e13565b92915050565b600060208201905081810360008301526157d58184614e67565b905092915050565b600060208201905081810360008301526157f681614e9d565b9050919050565b6000602082019050818103600083015261581681614ed4565b9050919050565b6000602082019050818103600083015261583681614f31565b9050919050565b6000602082019050818103600083015261585681614f68565b9050919050565b6000602082019050818103600083015261587681614f9f565b9050919050565b6000602082019050818103600083015261589681614ffc565b9050919050565b600060208201905081810360008301526158b681615033565b9050919050565b600060208201905081810360008301526158d681615090565b9050919050565b600060208201905081810360008301526158f6816150ed565b9050919050565b600060208201905081810360008301526159168161514a565b9050919050565b6000602082019050818103600083015261593681615181565b9050919050565b60006020820190508181036000830152615956816151b8565b9050919050565b60006020820190508181036000830152615976816151ef565b9050919050565b600060208201905081810360008301526159968161524c565b9050919050565b600060208201905081810360008301526159b6816152a9565b9050919050565b600060208201905081810360008301526159d6816152e0565b9050919050565b600060208201905081810360008301526159f681615317565b9050919050565b60006020820190508181036000830152615a1681615374565b9050919050565b60006020820190508181036000830152615a36816153ab565b9050919050565b60006020820190508181036000830152615a5681615408565b9050919050565b60006020820190508181036000830152615a7681615465565b9050919050565b60006020820190508181036000830152615a968161549c565b9050919050565b60006020820190508181036000830152615ab6816154d3565b9050919050565b60006020820190508181036000830152615ad68161550a565b9050919050565b60006020820190508181036000830152615af681615541565b9050919050565b60006020820190508181036000830152615b1681615578565b9050919050565b60006020820190508181036000830152615b36816155af565b9050919050565b60006020820190508181036000830152615b56816155e6565b9050919050565b60006020820190508181036000830152615b768161561d565b9050919050565b60006020820190508181036000830152615b9781846156a9565b905092915050565b6000602082019050615bb460008301846156e6565b92915050565b6000604082019050615bcf60008301856156e6565b615bdc6020830184614d3f565b9392505050565b6000604082019050615bf860008301856156e6565b615c056020830184614d30565b9392505050565b6000604082019050615c2160008301856156e6565b8181036020830152615c338184614e31565b90509392505050565b6000602082019050615c5160008301846156f5565b92915050565b6000604051905081810181811067ffffffffffffffff82111715615c7a57600080fd5b8060405250919050565b600067ffffffffffffffff821115615c9b57600080fd5b602082029050602081019050919050565b6000602082019050919050565b6000602082019050919050565b600081519050919050565b600081519050919050565b600081519050919050565b600081519050919050565b6000602082019050919050565b6000602082019050919050565b6000615d1782615d72565b9050919050565b6000615d2982615d72565b9050919050565b60008115159050919050565b6000819050919050565b60007fffffffff0000000000000000000000000000000000000000000000000000000082169050919050565b600073ffffffffffffffffffffffffffffffffffffffff82169050919050565b6000819050919050565b600064ffffffffff82169050919050565b6000615db882615d72565b9050919050565b6000615dca82615d72565b9050919050565b60008115159050919050565b6000819050919050565b600061ffff82169050919050565b6000819050919050565b600060ff82169050919050565b6000615e1782615e1e565b9050919050565b6000615e2982615e30565b9050919050565b6000615e3b82615d72565b9050919050565b60005b83811015615e60578082015181840152602081019050615e45565b83811115615e6f576000848401525b50505050565b6000601f19601f830116905091905056fea265627a7a723058206c40c1fc4f987517983f4c145ead93726cf13a6c0f76a3962cc086bc1c4b82126c6578706572696d656e74616cf50037";
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
		address: "0x920e270C53A792F7433a782acdc041A579d6d928",
		updated_at: 1586768463821
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
 * TODO: consider making this a singleton?
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
    // default instance

    this.defaultInstance = null; // ephemeral instance

    this.ephemeralInstance = null;
    this.ozWeb3 = null;
    this.fmWeb3 = null;
    this.schema = {};

    this._initialize();

    this.config = {
      gasPrice: '1000000000'
    };
    this.debug = true;
  }
  /**
   * We should setup the web3 components if not passed in
   * @private
   */


  _createClass(ELA_JS, [{
    key: "_initialize",
    value: function _initialize() {
      if (this.defaultWeb3) {
        this.defaultInstance = new this.defaultWeb3.eth.Contract(ELAJSStoreJSON.abi, this.contractAddress);
      }

      if (this.ephemeralWeb3) {
        // the ozWeb3 is constructed slightly differently
        this.ephemeralInstance = new this.ephemeralWeb3.lib.eth.Contract(ELAJSStoreJSON.abi, this.contractAddress);
      } // 1. fetch table list
      // 2. lazy fetch schema?

    }
  }, {
    key: "setProvider",
    value: function setProvider(provider) {} // fm call only

  }, {
    key: "createTable",
    value: function () {
      var _createTable = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime.mark(function _callee(tableName, permission, cols, colTypes) {
        var tableNameValue, tableKey;
        return _regeneratorRuntime.wrap(function _callee$(_context) {
          while (1) {
            switch (_context.prev = _context.next) {
              case 0:
                tableNameValue = Web3.utils.stringToHex(tableName);
                tableKey = namehash(tableName);

                if (this.debug) {
                  console.log('createTable', tableKey);
                  console.log(tableNameValue); // this should only work locally, fortmatic would use a different path

                  console.log(this.defaultWeb3.eth.personal.currentProvider.addresses[0]);
                  console.log('gasPrice', this.config.gasPrice);
                }

                _context.next = 5;
                return this.defaultInstance.methods.createTable(tableNameValue, tableKey, permission, [], []).send({
                  from: this.defaultWeb3.eth.personal.currentProvider.addresses[0],
                  gasPrice: this.config.gasPrice
                });

              case 5:
              case "end":
                return _context.stop();
            }
          }
        }, _callee, this);
      }));

      function createTable(_x, _x2, _x3, _x4) {
        return _createTable.apply(this, arguments);
      }

      return createTable;
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
      var _insertRow = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime.mark(function _callee2(tableName, cols, values, options) {
        var id, idKey, tableKey, idTableKey, i, fieldIdTableKey, fieldKey;
        return _regeneratorRuntime.wrap(function _callee2$(_context2) {
          while (1) {
            switch (_context2.prev = _context2.next) {
              case 0:
                if (!(options.id && (options.id.substring(0, 2) !== '0x' || options.id.length !== 66))) {
                  _context2.next = 2;
                  break;
                }

                throw new Error('options.id must be a 32 byte hex string prefixed with 0x');

              case 2:
                if (!(cols.length !== values.length)) {
                  _context2.next = 4;
                  break;
                }

                throw new Error('cols, values arrays must be same length');

              case 4:
                id = options.id || Web3.utils.randomHex(32);
                idKey = keccak256(id.substring(2));
                tableKey = namehash(tableName);
                idTableKey = namehash("".concat(id.substring(2), ".").concat(tableName)); // check id
                // TODO: check cache for table schema? Be lazy for now and always check?

                i = 0;

              case 9:
                if (!(i < cols.length)) {
                  _context2.next = 18;
                  break;
                }

                fieldIdTableKey = namehash("".concat(cols[i], ".").concat(id.substring(2), ".").concat(tableName));
                console.log("fieldIdTableKey = ".concat(fieldIdTableKey));
                fieldKey = keccak256(cols[i]);
                _context2.next = 15;
                return this.ephemeralInstance.methods.insertVal(tableKey, idTableKey, fieldIdTableKey, idKey, fieldKey, id, values[i]).send({
                  from: this.ephemeralWeb3.accounts[0]
                });

              case 15:
                i++;
                _context2.next = 9;
                break;

              case 18:
              case "end":
                return _context2.stop();
            }
          }
        }, _callee2, this);
      }));

      function insertRow(_x5, _x6, _x7, _x8) {
        return _insertRow.apply(this, arguments);
      }

      return insertRow;
    }()
  }, {
    key: "_insertVal",
    value: function () {
      var _insertVal2 = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime.mark(function _callee3(tableKey, idTableKey, fieldIdTableKey) {
        return _regeneratorRuntime.wrap(function _callee3$(_context3) {
          while (1) {
            switch (_context3.prev = _context3.next) {
              case 0:
              case "end":
                return _context3.stop();
            }
          }
        }, _callee3);
      }));

      function _insertVal(_x9, _x10, _x11) {
        return _insertVal2.apply(this, arguments);
      }

      return _insertVal;
    }()
    /**
     * This is a call so we can always use ephemeral
     *
     * @param tableName
     * @param id - Should not have leading 0x
     * @param fieldName
     * @private
     */

  }, {
    key: "_getVal",
    value: function () {
      var _getVal2 = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime.mark(function _callee4(tableName, id, fieldName) {
        var fieldIdTableKey, result;
        return _regeneratorRuntime.wrap(function _callee4$(_context4) {
          while (1) {
            switch (_context4.prev = _context4.next) {
              case 0:
                if (!(id.substring(0, 2) !== '0x' || id.length !== 66)) {
                  _context4.next = 2;
                  break;
                }

                throw new Error('id must be a 32 byte hex string prefixed with 0x');

              case 2:
                // always strip the 0x
                id = id.substring(2);
                fieldIdTableKey = namehash("".concat(fieldName, ".").concat(id, ".").concat(tableName));
                _context4.next = 6;
                return this.ephemeralInstance.methods.getRowValue(fieldIdTableKey).call();

              case 6:
                result = _context4.sent;
                return _context4.abrupt("return", result);

              case 8:
              case "end":
                return _context4.stop();
            }
          }
        }, _callee4, this);
      }));

      function _getVal(_x12, _x13, _x14) {
        return _getVal2.apply(this, arguments);
      }

      return _getVal;
    }()
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
