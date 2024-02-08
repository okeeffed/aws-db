# AWS Debug

A helper for debugging CloudFormation deployments without always searching through CloudFormation.

## How to use

```bash
# or pnpx, bunx etc.
$ npx @okeeffe/aws-dbg@latest
```

It will prompt you for your profile name and the match you which to target.

## SSO Login

If you need to configure SSO, follow the prompts from the `aws configure sso` screen.

```bash
$ aws configure sso
# Follow prompts until you set the profile
```

It will request things like your start URL e.g. `https://your-app.awsapps.com/start`.

If your session is expired, you can renew it with `aws sso login`.
