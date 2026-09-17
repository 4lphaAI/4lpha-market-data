/** Shared tokenized-stock fixtures. Not a test file: the runner only globs `*.test.ts`. */

export const NVDAB = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";
export const ARQQON = "0x1161989389a991532dce453d04d6346c2581c907";
export const USDT = "0x55d398326f99059ff775485246999027b3197955";

/** Trimmed real rows from `GET /rwa/tokens?binanceChainId=56`, 2026-09-16. */
export const NVDAB_ROW = {
  binanceChainId: "56",
  tokenContractAddress: "0x02FCA66C1D1AFB4E2A7884261EB00F63598A7436",
  platformId: "bstock",
  assetType: 1,
  tokenName: "NVIDIA Corp",
  tokenSymbol: "NVDAB",
  decimals: "18",
  underlyingTicker: "NVDA",
  underlyingName: "NVIDIA Corporation",
  tokenToShareRatio: "1",
  tags: null,
  statusInfo: { openState: true, marketStatus: null, reasonCode: "TRADING", reasonMsg: null, nextOpenTime: null, nextCloseTime: null },
  tokenPrice: "215.84",
  referencePrice: "215.62",
  volume24H: "17362880000",
  marketCap: "28385091",
  peRatioTTM: "52.1",
};
export const ARQQON_ROW = {
  binanceChainId: "56",
  tokenContractAddress: ARQQON,
  platformId: "ondo",
  assetType: 1,
  tokenName: "Arqit Quantum (Ondo Tokenized)",
  tokenSymbol: "ARQQon",
  decimals: "18",
  underlyingTicker: "ARQQ",
  underlyingName: "Arqit Quantum Inc.",
  tokenToShareRatio: "1",
  statusInfo: { openState: false, marketStatus: "overnight", reasonCode: "UNSUPPORTED", reasonMsg: null, nextOpenTime: 1789651860000, nextCloseTime: 1789588740000 },
  tokenPrice: "19.24",
  referencePrice: "19.24",
  volume24H: "2248219.61122638",
  marketCap: "333082147",
  peRatioTTM: null,
};

/** Shaped like `token-pairs/v1/bsc/{NVDAB}` on 2026-09-17, trimmed. */
export const NVDAB_PAIRS = [
  {
    chainId: "bsc", dexId: "pancakeswap", labels: ["v3"], pairAddress: "0x8FB4243b553aC29BA088aCf00B9B7dA24bD6690C",
    baseToken: { address: "0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436", symbol: "NVDAB" },
    quoteToken: { address: "0x55d398326f99059fF775485246999027B3197955", symbol: "USDT" },
    priceUsd: "215.64", txns: { h24: { buys: 5147, sells: 5242 } }, volume: { h24: 1682760.93 }, liquidity: { usd: 2729189.89 },
  },
  {
    chainId: "bsc", dexId: "uniswap", pairAddress: "0xdd9d5164ccbc57be377a964fc064135b03d06177",
    baseToken: { address: NVDAB, symbol: "NVDAB" }, quoteToken: { address: USDT, symbol: "USDT" },
    priceUsd: "215.97", txns: { h24: { buys: 100, sells: 90 } }, volume: { h24: 1136000 }, liquidity: { usd: 325000 },
  },
  {
    chainId: "bsc", dexId: "pancakeswap", labels: ["v2"], pairAddress: "0x1000000000000000000000000000000000000001",
    baseToken: { address: NVDAB, symbol: "NVDAB" }, quoteToken: { address: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", symbol: "WBNB" },
    priceUsd: "216.57", txns: { h24: { buys: 3, sells: 4 } }, volume: { h24: 6000 }, liquidity: { usd: 15000 },
  },
  {
    // A memecoin quoted in NVDAB: the stock is the *quote* here.
    chainId: "bsc", dexId: "pancakeswap", labels: ["v2"], pairAddress: "0x2000000000000000000000000000000000000002",
    baseToken: { address: "0x3000000000000000000000000000000000000003", symbol: "NVIDIACAT" }, quoteToken: { address: NVDAB, symbol: "NVDAB" },
    priceUsd: "0.0001", volume: { h24: 51000 }, liquidity: { usd: 108000 },
  },
  {
    chainId: "bsc", dexId: "topaz", pairAddress: "0x4000000000000000000000000000000000000004",
    baseToken: { address: NVDAB, symbol: "NVDAB" }, quoteToken: { address: USDT, symbol: "USDT" },
    priceUsd: "215.96", liquidity: { usd: 16000 }, volume: { h24: 25000 },
  },
  { chainId: "bsc", dexId: "pancakeswap", pairAddress: "nope", baseToken: { address: NVDAB }, quoteToken: { address: USDT } },
];
