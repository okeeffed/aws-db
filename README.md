# AWS Debug

A helper for debugging CloudFormation deployments without always searching through CloudFormation.

## How to use

Note: At the moment, it requires a profile from SSO (will be updated soon).

If you need to configure SSO, follow the prompts from the `aws configure sso` screen.

```bash
$ aws configure sso
# Follow prompts until you set the profile
```

To run this.

```bash
# or pnpx, bunx etc.
$ npx @okeeffe/aws-dbg@latest
```

It will prompt you for your profile name and the match you which to target.
