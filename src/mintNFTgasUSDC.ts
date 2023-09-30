require("dotenv").config();
const chalk = require("chalk");
import inquirer from "inquirer"; // find out what it does

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

export const mintNFTgasUSDC = async () => {
  // ------------------------STEP 1: Initialise Biconomy Smart Account SDK--------------------------------//

  // creating an instance of a bundler
  const bundler = new Bundler({
    bundlerUrl: process.env.BUNDLER_URL || "", // find a way to fix this
    chainId: ChainId.POLYGON_MUMBAI,
    entryPointAddress: DEFAULT_ENTRYPOINT_ADDRESS, // singleton contract you have to double check it
  });

  // creating a provider and an instance of a smart account
  const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY || "", provider);

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

  console.log(
    "Step 2 is working and this is the txn:" + transaction.toString()
  );

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

  // Generate list of options for the user to select
  const choices = feeQuotes?.map((quote: any, index: number) => ({
    name: `Option ${index + 1}: ${quote.maxGasFee}: ${quote.symbol} `,
    value: index,
  }));
  // Use inquirer to prompt user to select an option
  const { selectedOption } = await inquirer.prompt([
    // find out what this inquirer package does
    {
      type: "list",
      name: "selectedOption",
      message: "Select a fee quote:",
      choices,
    },
  ]);
  const selectedFeeQuote = feeQuotes[selectedOption];
};
