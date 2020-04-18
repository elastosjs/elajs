
# ela-js - ElastosJS SDK - [www.elastosjs.com](https://www.elastosjs.com)

This SDK allows you to interact with your ElastosJS Smart Contract Databases.

## This is an ALPHA - Proof-of-Concept Version

Expect significant changes between this and the official release.

### All Methods are Temporary

Right now a lot of methods simply mirror the smart contract, but in the later versions we plan to 
make it more similar to [https://github.com/hiddentao/squel](Squel) where you build query objects.

Then we would translate those query objects into a promise and issues successive calls to the smart
contract to apply that query. 

### Semantics

- we expect `bytes32` to be `Buffers`
- a hex value always has the `0x` prefix
- any crypto functions always return a hex value, we assume you don't need intermediates  
