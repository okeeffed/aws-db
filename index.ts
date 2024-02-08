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
import prompts from "prompts";

let branch = process.env.BRANCH;
let profile = process.env.AWS_PROFILE;

const resourceTypeAllowList = [
  "AWS::DynamoDB::Table",
  "AWS::Lambda::Function",
  "AWS::Logs::LogGroup",
  "AWS::ApiGateway::RestApi",
];

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

const onCancel = () => {
  console.log("Cancelled by user. Exiting...");
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
      message: "Pick source file to generate sequence diagram for:",
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
      suggest: (input, choices) => {
        const regex = new RegExp(input, "i"); // Case-insensitive matching
        return Promise.resolve(
          choices.filter((choice) => regex.test(choice.title))
        );
      },
    },
    {
      onCancel,
    }
  );

  console.log(response.url);
  open(response.url);

  // Recurse until user exits
  openResource(resources, region);
}

function getCurrentBranchName(): string {
  return execSync("git rev-parse --abbrev-ref HEAD").toString().trim();
}

async function findStacksByBranchName(
  branchName: string,
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

    const matchingStacks = Stacks.filter(
      (stack) => stack.StackName && stack.StackName.includes(branchName)
    );

    if (matchingStacks.length === 0) {
      spinner.fail("No matching stacks found. Exiting...");
      process.exit();
    }

    spinner.succeed("Stacks found");

    for (const stack of matchingStacks) {
      console.log(`Match found for stack: ${stack.StackName}`);
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
    matchingStacksSpinner.succeed(`Resources found for branch`);

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
  if (!profile) {
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

  if (!branch) {
    const response = await prompts(
      {
        type: "text",
        name: "branch",
        message: "Enter the branch name",
      },
      {
        onCancel,
      }
    );

    branch = response.branch;
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

  const branchName = branch || getCurrentBranchName();
  findStacksByBranchName(branchName, cloudFormationClient, region);
}

main();
