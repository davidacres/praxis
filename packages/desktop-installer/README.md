# Praxis Desktop installer launcher

This temporary package downloads and verifies the self-signed Praxis Windows
test installer from GitHub Releases.

Configure GitHub Packages and authenticate, then run:

```powershell
npm config set '@davidacres:registry' 'https://npm.pkg.github.com'
npm config set '//npm.pkg.github.com/:_authToken' '${GITHUB_TOKEN}'
npm install --global @davidacres/praxis-desktop@0.3.3-selfsigned.1
praxis-desktop install
```

Because the repository is private, the launcher also needs `GH_TOKEN`,
`GITHUB_TOKEN`, or an authenticated GitHub CLI session to download the release.
The token must include `read:packages` for npm installation and `repo` for the
private release download.

To download without launching the installer:

```powershell
praxis-desktop download --output $env:TEMP
```

This is a self-signed development build. It is not Apple-notarized or signed by
a publicly trusted Windows certificate authority. Do not install its included
test certificate on a machine you do not control.
