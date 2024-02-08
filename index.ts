#!/usr/bin/env node

import {
  CloudFormationClient,
  DescribeStacksCommand,
  paginateListStackResources,
} from "@aws-sdk/client-cloudformation";
import type { StackResourceSummary } from "@aws-sdk/client-cloudformation";
import { execSync } from "child_process";
import { fromIni } from "@aws-sdk/credential-provider-ini";
import open from "open";
import ora from "ora";
import prompts, { Choice } from "prompts";
import chalk from "chalk";
import ini from "ini";
import { readFile } from "fs/promises";
import Fuse from "fuse.js";

const configFile = `${process.env.HOME}/.aws/config`;
let match = process.env.match;
let profile = process.env.AWS_PROFILE;

const resourceTypeAllowList = [
  "AWS::DynamoDB::Table",
  "AWS::Lambda::Function",
  "AWS::Logs::LogGroup",
  "AWS::ApiGateway::RestApi",
];

// Function to check if a flag exists
function hasFlag(flag: string) {
  return process.argv.includes(flag);
}

// Function to get the value following a flag
function getFlagValue(flag: string) {
  const index = process.argv.indexOf(flag);
  if (index !== -1 && index + 1 < process.argv.length) {
    return process.argv[index + 1];
  }
  return null; // Flag not found or no value specified
}

const suggest = async (input: string, choices: Choice[]) => {
  const data = choices.map((choice) => choice.title);

  // Initialize Fuse.js with data and fuzzy matching options
  const fuse = new Fuse(data, {
    includeScore: true,
    threshold: 0.5, // Adjust the fuzzy matching threshold as needed
  });

  if (!input) {
    return choices;
  }

  const results = fuse.search(input);
  return results.map((result) => choices[result.refIndex]);
};

/**
 * Add more resources as required. You might need to debug their URLs.
 */
function constructResourceURL(
  resourceType: string = "unknown",
  resourceId: string = "unknown",
  region: string
): string | undefined {
  const baseUrl = `https://${region}.console.aws.amazon.com`;
  switch (resourceType) {
    case "AWS::DynamoDB::Table":
      return `${baseUrl}/dynamodb/home?region=${region}#tables:selected=${resourceId};tab=overview`;
    case "AWS::Lambda::Function":
      return `${baseUrl}/lambda/home?region=${region}#/functions/${resourceId}`;
    case "AWS::Logs::LogGroup":
      return `${baseUrl}/cloudwatch/home?region=${region}#logsV2:log-groups/log-group/${resourceId.replace(
        /\//g,
        "$252F"
      )}`;
    case "AWS::ApiGateway::RestApi":
      return `${baseUrl}/apigateway/main/apis/${resourceId}/resources?api=${resourceId}&region=${region}`;
    default:
      // Construct URLs for other resource types as needed
      return undefined; // Return undefined or a default URL if the resource type is not handled
  }
}

async function getProfileFromConfigFile() {
  try {
    // Read the AWS config file
    const data = await readFile(configFile, "utf8");

    // Parse the INI data
    const parsedData = ini.parse(data);

    // Extract profile names
    const profileNames = Object.keys(parsedData)
      .filter((key) => key.startsWith("profile "))
      .map((key) => key.substring(8));

    // Print the profile names
    return {
      success: true,
      profileNames,
    };
  } catch (error) {
    console.warn(
      chalk.yellow(
        "An error occurred while reading the AWS config file. Defaulting to input."
      )
    );

    return {
      success: false,
    };
  }
}

const onCancel = () => {
  console.warn(chalk.yellow("Cancelled by user. Exiting..."));
  process.exit(0);
};

async function openResource(resources: StackResourceSummary[], region: string) {
  let filteredResources = resources
    .filter((resource) =>
      resourceTypeAllowList.includes(resource.ResourceType!)
    )
    // Sort by alphabetically
    .sort((a, b) => {
      if (a.ResourceType! < b.ResourceType!) {
        return -1;
      }
      if (a.ResourceType! > b.ResourceType!) {
        return 1;
      }
      return 0;
    });

  const response = await prompts(
    {
      type: "autocomplete",
      name: "url",
      message: "Pick resource to open URL for:",
      choices: filteredResources.map((resource) => ({
        title: `[${resource.ResourceType?.replace("AWS::", "")}]: ${
          resource.LogicalResourceId
        }`,
        value: constructResourceURL(
          resource.ResourceType,
          resource.PhysicalResourceId,
          region
        ),
      })),
      suggest,
    },
    {
      onCancel,
    }
  );

  console.log(`${chalk.bgGreen("Opening URL")}: ${chalk.green(response.url)}`);
  open(response.url);

  // Recurse until user exits
  openResource(resources, region);
}

function getCurrentMatch(): string {
  return execSync("git rev-parse --abbrev-ref HEAD").toString().trim();
}

async function findStacksByMatch(
  match: string,
  client: CloudFormationClient,
  region: string
): Promise<void> {
  try {
    const spinner = ora("Fetching stacks").start();
    const command = new DescribeStacksCommand({});
    const { Stacks } = await client.send(command);

    if (!Stacks || Stacks.length === 0) {
      spinner.fail("No stacks found. Exiting...");
      process.exit();
    }

    const matchRegex = new RegExp(match, "i");
    const matchingStacks = Stacks.filter(
      (stack) => stack.StackName && matchRegex.test(stack.StackName)
    );

    if (matchingStacks.length === 0) {
      spinner.fail("No matching stacks found. Exiting...");
      process.exit();
    }

    spinner.succeed("Stacks found");

    for (const stack of matchingStacks) {
      console.log(
        `${chalk.bgGreen("Match found for stack:")} ${stack.StackName}`
      );
    }

    const matchingStacksSpinner = ora("Fetching resources").start();

    const responses = await Promise.all(
      matchingStacks.map(async (stack) => {
        // Assume name exists
        return listStackResources(stack.StackName!, client);
      })
    );

    // Flatten the responses
    const flattenedResources = responses.reduce((acc, val) => {
      if (!val) {
        return acc;
      }

      return acc?.concat(val);
    }, []);

    if (!flattenedResources || flattenedResources.length === 0) {
      matchingStacksSpinner.fail("No resources found for stack");
      process.exit();
    }
    matchingStacksSpinner.succeed(`Resources found for match`);

    // Open a resource
    await openResource(flattenedResources, region);
  } catch (error) {
    console.error("An error occurred:", error);
  }
}

async function listStackResources(
  stackName: string,
  client: CloudFormationClient
) {
  try {
    const paginator = paginateListStackResources(
      { client }, // Pagination configuration
      { StackName: stackName } // Input parameters for the ListStackResourcesCommand
    );

    let resources: StackResourceSummary[] = [];

    for await (const page of paginator) {
      // Each page is a response with a subset of the list of stack resources
      page.StackResourceSummaries?.forEach((resource) =>
        resources.push(resource)
      );
    }

    return resources;
  } catch (error) {
    console.error("Error listing stack resources:", error);
  }
}

async function main() {
  // Check for presence of -p or --profile flag and get its value
  const profileFlag = hasFlag("-p") || hasFlag("--profile");
  const profileValue = profileFlag
    ? getFlagValue("-p") || getFlagValue("--profile")
    : null;

  // Check for presence of -m or --match flag and get its value
  const matchFlag = hasFlag("-m") || hasFlag("--match");
  const matchValue = matchFlag
    ? getFlagValue("-m") || getFlagValue("--match")
    : null;

  // Use the values if present
  if (profileFlag && profileValue) {
    profile = profileValue;
  } else {
    const getProfileFromConfigFileResponse = await getProfileFromConfigFile();

    if (
      getProfileFromConfigFileResponse.success &&
      getProfileFromConfigFileResponse.profileNames &&
      getProfileFromConfigFileResponse.profileNames.length > 0
    ) {
      const response = await prompts(
        {
          type: "autocomplete",
          name: "profile",
          message: "Enter the AWS profile name",
          suggest,
          choices: getProfileFromConfigFileResponse.profileNames.map(
            (name) => ({
              title: name,
              value: name,
            })
          ),
        },
        {
          onCancel,
        }
      );

      profile = response.profile;
    } else {
      const response = await prompts(
        {
          type: "text",
          name: "profile",
          message: "Enter the AWS profile name",
        },
        {
          onCancel,
        }
      );

      profile = response.profile;
    }
  }

  if (matchFlag && matchValue) {
    match = matchValue;
  } else {
    const response = await prompts(
      {
        type: "text",
        name: "match",
        message: "Enter the text to match against stack names",
      },
      {
        onCancel,
      }
    );

    match = response.match;
  }

  // Default to Sydvegas
  const region = process.env.AWS_REGION || "ap-southeast-2";

  // Create a credentials provider
  const credentials = fromIni({ profile });

  // Create a CloudFormation client with the specified credentials and region
  const cloudFormationClient = new CloudFormationClient({
    region,
    credentials,
  });

  const Match = match || getCurrentMatch();
  findStacksByMatch(Match, cloudFormationClient, region);
}

main();
