require("dotenv").config();
const chalk = require("chalk");

// to prove that USDC has effectively been used to pay the mint
import { utils } from "ethers";

// importing the bundler package and providers from the ethers package
import { Bundler } from "@biconomy/bundler";
import { ethers } from "ethers";
import { ChainId } from "@biconomy/core-types";
import {
  BiconomySmartAccountV2, // used to create the instance of the smart account
  DEFAULT_ENTRYPOINT_ADDRESS,
} from "@biconomy/account";

// importing the ECSDA to create the SCW
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

// Create an ethers provider and wallet
const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY || "", provider);

// USDC contract address
const usdcAddress = process.env.USDC_ADDRESS || ""; // Replace with your actual USDC token contract address

// Create a contract instance for USDC
const usdcContract = new ethers.Contract(
  usdcAddress,
  ["function balanceOf(address) view returns (uint256)"],
  wallet
);

// Function to fetch USDC balance of the EOA wallet
const getUSDCBalance = async () => {
  const usdcBalance = await usdcContract.balanceOf(wallet.address);
  return usdcBalance;
};

export const mintNFTgasUSDC = async () => {
  // ------------------------STEP 1: Initialise Biconomy Smart Account SDK--------------------------------//

  // creating an instance of a bundler
  const bundler = new Bundler({
    bundlerUrl: process.env.BUNDLER_URL || "", // find a way to fix this
    chainId: ChainId.POLYGON_MUMBAI,
    entryPointAddress: DEFAULT_ENTRYPOINT_ADDRESS, // singleton contract you have to double check it
  });

  // showing the EOA wallet address
  const eoa = await wallet.getAddress();
  console.log(chalk.blue(`EOA address: ${eoa}`));

  // double check if this is needed or not, maybe there are other modules you can use to create the SCW
  const ecdsaModule = await ECDSAOwnershipValidationModule.create({
    signer: wallet,
    moduleAddress: DEFAULT_ECDSA_OWNERSHIP_MODULE,
  });

  const paymaster = new BiconomyPaymaster({
    paymasterUrl: process.env.PAYMASTER_URL || "",
  });

  // is this the creatiion of the smartaccount ???
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

  // create biconomy smart account instance
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

  // Here we are minting NFT to smart account address itself
  const data = nftInterface.encodeFunctionData("safeMint", [scwAddress]);

  const nftAddress = process.env.NFT_ADDRESS;

  const transaction = {
    to: nftAddress || "",
    data: data,
  };

  // build partial userOp --- YOU HAVE TO UNDERSTAND ALL OF THESE FUNCTIONS
  let partialUserOp = await biconomySmartAccount.buildUserOp([transaction]);

  let finalUserOp = partialUserOp;

  console.log("Step 2 is working and this is the txn:" + transaction.data);

  // ------------------------STEP 3: Get Fee quotes for USDC from the paymaster--------------------------------//

  const biconomyPaymaster =
    biconomySmartAccount.paymaster as IHybridPaymaster<SponsorUserOperationDto>;

  const feeQuotesResponse = await biconomyPaymaster.getPaymasterFeeQuotesOrData(
    partialUserOp,
    {
      // here we are explicitly telling by mode ERC20 that we want to pay in ERC20 tokens and expect fee quotes
      mode: PaymasterMode.ERC20,
      // for this script, we pass an empty array which returns the quotes for all of the tokens supported by
      tokenList: [],
      // preferredToken is optional. If you want to pay in a specific token, you can pass its address here and get fee quotes for that token only
      preferredToken: process.env.USDC,
    }
  );

  const feeQuotes = feeQuotesResponse.feeQuotes as PaymasterFeeQuote[];
  const spender = feeQuotesResponse.tokenPaymasterAddress || "";
  // Find the USDC fee quote if it exists, or set a default fee quote
  const selectedFeeQuote =
    feeQuotes.find((quote) => quote.symbol === "USDC") || feeQuotes[0];

  console.log("The selected feequote is " + selectedFeeQuote.decimal);
  console.log("The token that is used to pay is " + selectedFeeQuote.symbol);

  // ------------------------STEP 4: Get Paymaster and Data from Biconomy Paymaster --------------------------------//

  finalUserOp = await biconomySmartAccount.buildTokenPaymasterUserOp(
    partialUserOp,
    {
      feeQuote: selectedFeeQuote,
      spender: spender,
      maxApproval: false,
    }
  );

  console.log(
    "This is the final userOp that will be sent to the bundler" +
      finalUserOp.paymasterAndData
  );

  // ------------------------STEP 5: Get Paymaster and Data from Biconomy Paymaster --------------------------------//

  let paymasterServiceData = {
    mode: PaymasterMode.ERC20, // - mandatory // now we know chosen fee token and requesting paymaster and data for it
    feeTokenAddress: selectedFeeQuote.tokenAddress,
    // optional params..
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

  console.log("Step 5 is working");

  // ------------------------STEP 6: Sign the UserOp and send to the Bundler--------------------------------//

  console.log(chalk.blue(`userOp: ${JSON.stringify(finalUserOp, null, "\t")}`));

  // Below function gets the signature from the user (signer provided in Biconomy Smart Account)
  // and also send the full op to attached bundler instance

  /**
  const balanceBefore = await getUSDCBalance();
  console.log("The USDC balance is: " + balanceBefore);
   */

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
  /** 
  const balanceAfter = await getUSDCBalance();
  console.log("The USDC balance after: " + balanceAfter);
  */

  console.log(
    "Go check you new NFT minted at https://testnets.opensea.io/" + scwAddress
  );
};
