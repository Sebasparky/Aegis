/**
 * Generates an Ed25519 JWK key pair for receipt signing.
 * Prints the two env-var assignments to stdout — does not write to disk.
 *
 * Usage:
 *   node apps/api/scripts/generate-receipt-keypair.mjs
 *
 * Paste the printed lines into your .env:
 *   AEGIS_RECEIPT_JWS_PRIVATE_JWK='...'
 *   AEGIS_RECEIPT_JWS_PUBLIC_JWK='...'
 */
import { generateKeyPair, exportJWK } from "jose";

const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" });

const privateJwk = await exportJWK(privateKey);
const publicJwk = await exportJWK(publicKey);

process.stdout.write(`AEGIS_RECEIPT_JWS_PRIVATE_JWK='${JSON.stringify(privateJwk)}'\n`);
process.stdout.write(`AEGIS_RECEIPT_JWS_PUBLIC_JWK='${JSON.stringify(publicJwk)}'\n`);
