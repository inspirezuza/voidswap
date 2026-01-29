/**
 * @voidswap/tx-template
 * 
 * EIP-1559 transfer template builder and signing digest computation.
 */

// Schema exports
export {
    Eip1559TransferTemplateSchema,
    EthAddressSchema,
    PositiveBigIntSchema,
    ChainIdSchema,
    type Eip1559TransferTemplate,
    type UnsignedEip1559Tx,
} from './schema.js';

// Transfer builder exports
export {
    buildEip1559TransferTx,
    serializeUnsignedEip1559,
    signingDigestEip1559,
    type Eip1559TransferTemplateInput,
} from './transfer.js';
