require("dotenv").config();
const chalk = require("chalk");

// importing the bundler package and providers from the ethers package
import { Bundler } from "@biconomy/bundler";
import { ethers } from "ethers";
import { ChainId } from "@biconomy/core-types";
import {
  BiconomySmartAccountV2, // used to create the instance of the smart account
  DEFAULT_ENTRYPOINT_ADDRESS,
} from "@biconomy/account";

// importing the ECSDA module to create the SCA
import {
  ECDSAOwnershipValidationModule,
  DEFAULT_ECDSA_OWNERSHIP_MODULE,
} from "@biconomy/modules";

//importing for setting up the paymaster
import { BiconomyPaymaster } from "@biconomy/paymaster";

// imports for the setting the token paymaster mode and being able to pay with USDC
import {
  IHybridPaymaster,
  PaymasterFeeQuote,
  PaymasterMode,
  SponsorUserOperationDto,
} from "@biconomy/paymaster";

//----------------------------------------------------------------------------------

export const mintNFTgasUSDC = async () => {
  // ------------------------STEP 1: Initialise Biconomy Smart Account SDK--------------------------------//

  // Create an ethers provider and wallet
  let provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL);
  let wallet = new ethers.Wallet(process.env.PRIVATE_KEY || "", provider);

  // showing the EOA wallet address
  const eoa = await wallet.getAddress();
  console.log(chalk.blue(`EOA address: ${eoa}`));

  // creating an instance of a bundler
  const bundler = new Bundler({
    bundlerUrl: process.env.BUNDLER_URL || "",
    chainId: ChainId.POLYGON_MUMBAI,
    entryPointAddress: DEFAULT_ENTRYPOINT_ADDRESS, // only one deployed in each EVM
  });

  // creating an instance of a paymaster
  const paymaster = new BiconomyPaymaster({
    paymasterUrl: process.env.PAYMASTER_URL || "",
  });

  // using ECSDA module to generate signature for SCA
  const ecdsaModule = await ECDSAOwnershipValidationModule.create({
    signer: wallet,
    moduleAddress: DEFAULT_ECDSA_OWNERSHIP_MODULE,
  });

  // setting up all of the appropriate args for the creationg of the SCA
  const biconomySmartAccountConfig = {
    signer: wallet,
    chainId: ChainId.POLYGON_MUMBAI,
    rpcUrl: process.env.RPC_URL,
    paymaster: paymaster,
    bundler: bundler,
    entryPointAddress: DEFAULT_ENTRYPOINT_ADDRESS,
    defaultValidationModule: ecdsaModule,
    activeValidationModule: ecdsaModule,
  };

  // create biconomy SCA instance
  const biconomySmartAccount = await BiconomySmartAccountV2.create(
    biconomySmartAccountConfig
  );

  const scwAddress = await biconomySmartAccount.getAccountAddress();

  console.log("The SCW has been created at: " + scwAddress);

  // ------------------------STEP 2: Build Partial User op from your user Transaction/s Request --------------------------------//

  // generate mintNft data
  const nftInterface = new ethers.utils.Interface([
    "function safeMint(address _to)",
  ]);

  // setting up what we want the UserOp to do once it is executed by the bundler
  const data = nftInterface.encodeFunctionData("safeMint", [scwAddress]);
  const nftAddress = process.env.NFT_ADDRESS;
  const transaction = {
    to: nftAddress || "",
    data: data,
  };

  // build partial userOp
  let partialUserOp = await biconomySmartAccount.buildUserOp([transaction]);
  // it ocassionaly breaks when building the partial UserOP with a UnhandledPromiseRejection Error
  let finalUserOp = partialUserOp;

  // ------------------------STEP 3: Set USDC payment of gas--------------------------------//

  const biconomyPaymaster =
    biconomySmartAccount.paymaster as IHybridPaymaster<SponsorUserOperationDto>;

  const setUSDC = await biconomyPaymaster.getPaymasterFeeQuotesOrData(
    partialUserOp,
    {
      mode: PaymasterMode.ERC20, // activating mode to pay in ERC20 tokens and expect fee quotes
      tokenList: [],
      preferredToken: process.env.USDC, // setting USDC as the token we will use to pay
    }
  );

  const feeQuotes = setUSDC.feeQuotes as PaymasterFeeQuote[];
  const spender = setUSDC.tokenPaymasterAddress || "";

  // Find the USDC fee quote if it exists, or set a default fee quote
  const selectedFeeQuote =
    feeQuotes.find((quote) => quote.symbol === "USDC") || feeQuotes[0];

  console.log("The token that is used to pay is " + selectedFeeQuote.symbol);

  // ------------------------STEP 4: Get Paymaster and Data from Biconomy Paymaster --------------------------------//

  // now we add the additional fields to complete the UserOP
  finalUserOp = await biconomySmartAccount.buildTokenPaymasterUserOp(
    partialUserOp,
    {
      feeQuote: selectedFeeQuote,
      spender: spender,
      maxApproval: false,
    }
  );

  // ------------------------STEP 5: Get Paymaster and Data from Biconomy Paymaster --------------------------------//

  let paymasterServiceData = {
    mode: PaymasterMode.ERC20, // - mandatory // now we know chosen fee token and requesting paymaster and data for it
    feeTokenAddress: selectedFeeQuote.tokenAddress,
    calculateGasLimits: true, // Always recommended and especially when using token paymaster
  };

  try {
    const paymasterAndDataWithLimits =
      await biconomyPaymaster.getPaymasterAndData(
        finalUserOp,
        paymasterServiceData
      );
    finalUserOp.paymasterAndData = paymasterAndDataWithLimits.paymasterAndData;

    // below code is only needed if you sent the flag calculateGasLimits = true
    if (
      paymasterAndDataWithLimits.callGasLimit &&
      paymasterAndDataWithLimits.verificationGasLimit &&
      paymasterAndDataWithLimits.preVerificationGas
    ) {
      // Returned gas limits must be replaced in your op as you update paymasterAndData.
      // Because these are the limits paymaster service signed on to generate paymasterAndData
      // If you receive AA34 error check here..

      finalUserOp.callGasLimit = paymasterAndDataWithLimits.callGasLimit;
      finalUserOp.verificationGasLimit =
        paymasterAndDataWithLimits.verificationGasLimit;
      finalUserOp.preVerificationGas =
        paymasterAndDataWithLimits.preVerificationGas;
    }
  } catch (e) {
    console.log("error received ", e);
  }

  // ------------------------STEP 6: Sign the UserOp and send to the Bundler--------------------------------//

  console.log(chalk.blue(`userOp: ${JSON.stringify(finalUserOp, null, "\t")}`));

  // Below function gets the signature from the user (signer provided in Biconomy Smart Account)
  // and also send the full op to attached bundler instance

  try {
    const userOpResponse = await biconomySmartAccount.sendUserOp(finalUserOp);
    console.log(chalk.green(`userOp Hash: ${userOpResponse.userOpHash}`));
    const transactionDetails = await userOpResponse.wait();
    console.log(
      chalk.blue(
        `transactionDetails: ${JSON.stringify(transactionDetails, null, "\t")}`
      )
    );
  } catch (e) {
    console.log("error received ", e);
  }

  console.log(
    "Go check you new NFT minted at https://testnets.opensea.io/" + scwAddress
  );
};
