A build script to perform automated version bumping and publishing of mod updates.

## Features
* Increment the version number and rebuild the project using MsBuild.
* Package and upload a GitHub release.
* Publish a Steam workshop update.
* Publish a NuGet package update.

## Installation
`npm install -g git+https://github.com/UnlimitedHugs/RimworldModPublisher.git`

## Usage
The script requires the following files to be in place:
* Working directory must be a git repo
* MSBuild and SteamCmd must be installed and accessible via PATH.
* ./Properties/AssemblyInfo.cs for version bumping
* ../githubToken.txt for GitHub release publishing
* ../nugetToken.txt for NuGet update publishing
* ./Mods/$modName/About/About.xml for version bumping
* ./Mods/$modName/About/Version.xml for version bumping in override mode and GitHub release publishing
* ./Mods/$modName/About/PublishedFileId.txt for Steam update publishing

```
publish [options]

Options:
-v, --incrementVersion [major|minor|patch]  Increment the version number of the mod and rebuild the project. Defaults to "patch".
-g, --github                                publishes a release of the mod on GitHub
-s, --steam                                 publishes an update of the mod on the Steam workshop. Workshop item must already exist.
-n, --nuget                                 pushes an updated nupkg to nuget.org
-x, --skipPreChecks                         skips initial checks that ensure the git repo is committed and up to date with its remote
--preRelease                                marks the release as "pre-release" on GitHub
-h, --help                                  output usage information
```


