export const VENUS_COMPTROLLER_ABI = [
  { type: "function", name: "getAllMarkets", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }] },
  { type: "function", name: "getAssetsIn", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "address[]" }] },
  { type: "function", name: "oracle", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "deviationBoundedOracle", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "vaiController", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "getXVSAddress", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "prime", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "protocolPaused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "mintVAIGuardianPaused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "repayVAIGuardianPaused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "lastPoolId", stateMutability: "view", inputs: [], outputs: [{ type: "uint96" }] },
  { type: "function", name: "userPoolId", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint96" }] },
  {
    type: "function", name: "pools", stateMutability: "view", inputs: [{ type: "uint96" }],
    outputs: [{ name: "label", type: "string" }, { name: "isActive", type: "bool" }, { name: "allowCorePoolFallback", type: "bool" }],
  },
  { type: "function", name: "getPoolVTokens", stateMutability: "view", inputs: [{ type: "uint96" }], outputs: [{ type: "address[]" }] },
  {
    type: "function", name: "markets", stateMutability: "view", inputs: [{ type: "address" }],
    outputs: [
      { name: "isListed", type: "bool" }, { name: "collateralFactorMantissa", type: "uint256" },
      { name: "isVenus", type: "bool" }, { name: "liquidationThresholdMantissa", type: "uint256" },
      { name: "liquidationIncentiveMantissa", type: "uint256" }, { name: "poolId", type: "uint96" },
      { name: "isBorrowAllowed", type: "bool" },
    ],
  },
  {
    type: "function", name: "poolMarkets", stateMutability: "view",
    inputs: [{ type: "uint96" }, { type: "address" }],
    outputs: [
      { name: "isListed", type: "bool" }, { name: "collateralFactorMantissa", type: "uint256" },
      { name: "isVenus", type: "bool" }, { name: "liquidationThresholdMantissa", type: "uint256" },
      { name: "liquidationIncentiveMantissa", type: "uint256" }, { name: "poolId", type: "uint96" },
      { name: "isBorrowAllowed", type: "bool" },
    ],
  },
  {
    type: "function", name: "getEffectiveLtvFactor", stateMutability: "view",
    inputs: [{ type: "address" }, { type: "address" }, { type: "uint8" }], outputs: [{ type: "uint256" }],
  },
  {
    type: "function", name: "getEffectiveLiquidationIncentive", stateMutability: "view",
    inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }],
  },
  { type: "function", name: "getBorrowingPower", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "getAccountLiquidity", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "supplyCaps", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "borrowCaps", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "actionPaused", stateMutability: "view", inputs: [{ type: "address" }, { type: "uint8" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "isForcedLiquidationEnabled", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "isForcedLiquidationEnabledForUser", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "venusSupplySpeeds", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "venusBorrowSpeeds", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "venusAccrued", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  {
    type: "function", name: "claimVenus", stateMutability: "nonpayable",
    inputs: [{ name: "holder", type: "address" }, { name: "vTokens", type: "address[]" }], outputs: [],
  },
] as const;

export const VENUS_VTOKEN_ABI = [
  {
    type: "function", name: "getAccountSnapshot", stateMutability: "view", inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
  },
  { type: "function", name: "borrowBalanceCurrent", stateMutability: "nonpayable", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "exchangeRateCurrent", stateMutability: "nonpayable", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "exchangeRateStored", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "underlying", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "supplyRatePerBlock", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "borrowRatePerBlock", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "reserveFactorMantissa", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalBorrows", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalReserves", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getCash", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

export const VENUS_ORACLE_ABI = [
  { type: "function", name: "getUnderlyingPrice", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

export const VENUS_DBO_ABI = [
  {
    type: "function", name: "getBoundedPricesView", stateMutability: "view", inputs: [{ type: "address" }],
    outputs: [{ name: "collateralPrice", type: "uint256" }, { name: "debtPrice", type: "uint256" }],
  },
] as const;

export const VENUS_VAI_CONTROLLER_ABI = [
  { type: "function", name: "getVAIRepayAmount", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

export const ERC20_METADATA_ABI = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

export const VENUS_LENS_ABI = [
  {
    type: "function", name: "pendingRewards", stateMutability: "view",
    inputs: [{ name: "holder", type: "address" }, { name: "comptroller", type: "address" }],
    outputs: [{
      name: "", type: "tuple", components: [
        { name: "distributorAddress", type: "address" },
        { name: "rewardTokenAddress", type: "address" },
        { name: "totalRewards", type: "uint256" },
        { name: "pendingRewards", type: "tuple[]", components: [
          { name: "vTokenAddress", type: "address" }, { name: "amount", type: "uint256" },
        ] },
      ],
    }],
  },
] as const;

export const VENUS_PRIME_V2_ABI = [
  { type: "function", name: "getAllMarkets", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }] },
  { type: "function", name: "isUserPrimeHolder", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  {
    type: "function", name: "getPendingRewardsStatic", stateMutability: "view", inputs: [{ type: "address" }],
    outputs: [{ name: "pendingRewards", type: "tuple[]", components: [
      { name: "vToken", type: "address" }, { name: "rewardToken", type: "address" }, { name: "amount", type: "uint256" },
    ] }],
  },
  {
    type: "function", name: "claimInterest", stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }],
  },
] as const;
