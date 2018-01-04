var fs = require('fs');
var child_process = require('child_process');
var process = require('process');
var util = require('util');
var path = require('path');

var _ = require("lodash");
var cmd = require("commander");
var runner = require("./task_runner")();
var colors = require("colors/safe");
var GitHubApi = require('github');
var Promise = require('bluebird');
var archiver = require('archiver');
var vdf = require('vdf');
var readline = require('readline-sync');
var xmlEscape = require('xml-escape');

var steamCMDPath = "C:/SteamCmd/steamcmd.exe";
var MSBuildPath = "C:/Windows/Microsoft.NET/Framework64/v4.0.30319/MSBuild.exe";
var MSBuildOptions = "/p:Configuration=Release /p:BuildProjectReferences=false /p:PreBuildEvent= /p:PostBuildEvent=";
var assemblyInfoPath = "./Properties/AssemblyInfo.cs";
var githubTokenPath = "../githubToken.txt";
var nugetTokenPath = "../nugetToken.txt";


function fatalError(message){
	console.error(message);
	process.exit(1);
}

function coerceVersionArg(value){
	if(!revisionTypes.hasOwnProperty(value)) fatalError("Invalid version argument: "+value);
	return value;
}

function matchFileContents(path, pattern){
	var contents;
	try {
		contents = fs.readFileSync(path).toString();
	} catch(err) {
		return null;
	}
	var match = contents.match(pattern);
	if(match!=null && match.length>1){
		return match[1];
	}
	return null;
}

function replaceMatchedCaptureInFile(path, pattern, replacement){
	var contents = fs.readFileSync(path).toString();
	var replacer = function(match, capture){
		return match.replace(capture, replacement);
	};
	var newContents = contents.replace(pattern, replacer);
	if(newContents != contents){
		fs.writeFileSync(path, newContents);
		return true;
	}
	return false;
}

function readAssemblyVersion(){
	var versionStr;
	var overrideVersion = matchFileContents(versionFilePath, overrideVersionPattern); // try to get override version first
	if(overrideVersion !== null){
		versionStr = overrideVersion;
		overrideVersionActive = true;
	} else {
		versionStr = matchFileContents(assemblyInfoPath, assemblyVersionPattern); // use assembly version otherwise
		if(versionStr === null) throw new Error("Invalid AssemblyInfo.cs contents!");
		overrideVersionActive = false;
	}
	var versionParts = versionStr.split('.');
	versionParts.length = 3;
	return versionParts.join('.');
}

function modNameFromWorkingDirectory(){
	var cwdParts = workingDirectory.split('/');
	return cwdParts[cwdParts.length-1];
}

function quote(str){
	return '"'+str+'"';
}

function readTokenFile(path){
	try {
		var contents = fs.readFileSync(path).toString();
	} catch(err) {
		console.log(("Failed to read token file at "+path).stylize('red'));
		throw err;
	}
	return contents.trim();
}

function findFileByExtension(dirPath, extension) {
	var files = fs.readdirSync(dirPath);
	for (var i = 0; i < files.length; i++) {
		var filename = path.join(dirPath, files[i]);
		if (filename.endsWith(extension)) {
			return filename;
		}
	}
}

//////////////////////////////////////////// SETUP ////////////////////////////////////////////
var workingDirectory = process.cwd().replace(/\\/g, '/');
var modName = modNameFromWorkingDirectory();
var modDirPath = workingDirectory + "/Mods/" + modName;
var versionFilePath = modDirPath + "/About/Version.xml";
var steamFileIdFilePath = modDirPath + "/About/PublishedFileId.txt";
var steamVDFFilePath = workingDirectory + "/SteamConfig.vdf";
var aboutFilePath = modDirPath + "/About/About.xml";
var steamPreviewPath = modDirPath + "/About/preview.png";
var steamConfigPath = workingDirectory + "/SteamConfig.json";
var nugetNuspecPath = workingDirectory + "/" + modName + ".nuspec";
var githubToken = readTokenFile(githubTokenPath);
var currentVersion = null;
var assemblyVersionPattern = /\[assembly: AssemblyVersion\("((?:\d|\.)+?)"\)\]/;
var assemblyFileVersionPattern = /\[assembly: AssemblyFileVersion\("((?:\d|\.)+?)"\)\]/;
var overrideVersionPattern = /overrideVersion>([\d\.]+)/;
var githubRepoPattern = /gitHubRepository>([\w\/]+)/;
var aboutVersionPattern = /Version: ([\d\.]+)/;
var nuspecVersionPattern = /version>([\d\.]+)/;
var nuspecChangelogPattern = /releaseNotes>([^<]+)/;
var githubRepoData = {};
var github = null;

var overrideVersionActive = false;

var revisionTypes = {"major":0, "minor":1, "patch":2};

cmd.option('-v, --incrementVersion ['+_.join(_.keys(revisionTypes), '|')+']', 'Increment the version number of the mod and rebuild the project. Defaults to "patch".', coerceVersionArg);
cmd.option('-g, --github', 'publishes a release of the mod on GitHub');
cmd.option('-s, --steam', 'publishes an update of the mod on the Steam workshop. Workshop item must already exist.');
cmd.option('-n, --nuget', 'pushes an updated nupkg to nuget.org');
cmd.option('-x, --skipPreChecks', 'skips initial checks that ensure the git repo is committed and up to date with its remote');
cmd.option('--preRelease', 'marks the release as "pre-release" on github');
cmd.parse(process.argv);
if(cmd.incrementVersion === true){
	cmd.incrementVersion = 'patch';
}

github = new GitHubApi({
	timeout: 10000,
	host: 'api.github.com',
	protocol: 'https',
	headers: {'user-agent': 'UnlimitedHugsModPublisher'},
	rejectUnauthorized: true
});
github.authenticate({
	type: 'token',
	token: githubToken
});

//////////////////////////////////////////// TASKS ////////////////////////////////////////////

function EnsureIsModDirectory(){
	if(!fs.existsSync(versionFilePath)){
		runner.fail("Version file not found: "+versionFilePath);
	}
}

function EnsureGitRemoteIsUpToDate(){
	child_process.execSync("git fetch");
	var localHead = child_process.execSync("git rev-parse HEAD").toString().trim();
	var remoteHead = child_process.execSync("git rev-parse @{u}").toString().trim();
	if(remoteHead != localHead){
		console.log("Git remote does not seem to be up to date: "+localHead+" (local) vs "+remoteHead+" (remote)");
		runner.fail();
	}
}

function EnsureEverythingCommitted(){
	var diff = child_process.execSync("git diff && git diff --cached");
	if(diff.length>1) {
		console.log("There are uncommitted changes: "+diff);
		runner.fail();
	}
}

function IncrementVersion(){
	var versionParts = currentVersion.split('.');
	var revisionType = cmd.incrementVersion;
	switch(revisionType){
		case 'major':
			versionParts[0]++;
			versionParts[1] = versionParts[2] = 0;
			break;
		case 'minor':
			versionParts[1]++;
			versionParts[2] = 0;
			break;
		case 'patch':
			versionParts[2]++;
			break;
		default:
			throw new Error("Unknown revision type: "+revisionType);
	}
	currentVersion = versionParts.join('.');
	return "New version is "+currentVersion;
}

function UpdateOverrideVersion(){
	if(!overrideVersionActive) {
		return "Override version inactive, skipping.";
	}
	replaceMatchedCaptureInFile(versionFilePath, overrideVersionPattern, currentVersion);
}

function UpdateAssemblyInfo(){
	if(overrideVersionActive) {
		return "Override version active, skipping.";
	}
	replaceMatchedCaptureInFile(assemblyInfoPath, assemblyVersionPattern, currentVersion);
	replaceMatchedCaptureInFile(assemblyInfoPath, assemblyFileVersionPattern, currentVersion);
}

function BuildAssembly(){
	if(overrideVersionActive) {
		return "Assembly info was not updated, skipping.";
	}
	if(!fs.existsSync(MSBuildPath)){
		runner.fail("Failed to find MSBuild at "+MSBuildPath);
		return;
	}
	try {
		child_process.execSync(quote(MSBuildPath) + " " + MSBuildOptions, [quote(process.cwd())]);
	} catch(err){
		runner.fail(err.stdout.toString());
	}
}

function UpdateAboutXmlVersion(){
	var replaced = replaceMatchedCaptureInFile(aboutFilePath, aboutVersionPattern, currentVersion);
	if(!replaced) return colors.yellow("About.xml version information not found, skipping.");
}

var packageFilename;
var packagePath;

function CreateReleasePackage(){
	return new Promise((resolve, reject) => {
		packageFilename = modName + "_" + currentVersion + ".zip";
		packagePath = workingDirectory + '/' + packageFilename;

		try {
			fs.unlinkSync(packagePath);
			console.log("Deleted existing package");
		} catch (err) {
		}

		var output = fs.createWriteStream(packagePath);
		var archive = archiver('zip', {
			zlib: {level: 9} // Sets the compression level.
		});

		output.on('close', function () {
			console.log("Created " + packagePath);
			resolve();
		});
		archive.on('warning', function (err) {
			if (err.code === 'ENOENT') {
				console.warn(err);
				resolve();
			} else {
				reject(err);
			}
		});
		archive.on('error', reject);

		archive.pipe(output);
		archive.directory(modDirPath, modName);
		archive.finalize();
	});
}

function CleanupPackagedRelease(){
	if(packagePath){
		fs.unlinkSync(packagePath);
	}
}

var commitMessage;

function FetchCommitMessage(){
	var stdout = child_process.execSync("git log -1 --pretty=%B");
	commitMessage = stdout.toString().trim();
}

function GetGitHubRepoPath(){
	var repoPath = matchFileContents(versionFilePath, githubRepoPattern);
	if(!_.isString(repoPath)){
		runner.fail("Could not parse repository path from version file: "+versionFilePath);
		return;
	}
	var parts = repoPath.split("/");
	githubRepoData = {owner:parts[0], repo:parts[1]};
	if(!githubRepoData.owner || !githubRepoData.repo){
		runner.fail("Improperly formatted repository path "+repoPath+" in file "+repoPath);
	}
}

var uploadUrl;

function MakeGithubRelease(){
	var commitLines = commitMessage.split('\n');
	var commitHeadline = commitLines[0];
	var otherLines = commitLines.filter(function(elem, idx){ return idx>0 && elem.length>0 }).join('\n');
	var commitish = "master";
	var payload = _.extend(githubRepoData, {
		tag_name: 'v'+currentVersion,
		target_commitish: commitish,
		name: commitHeadline,
		body: otherLines,
		draft: false,
		prerelease: !!cmd.preRelease
	});
	var readable = util.inspect(payload).replace(/\\n/g, '\n');
	console.log(readable);
	if(!readline.keyInYN("Create a release with these settings? (y/n): ")){
		runner.fail("User aborted release");
		return;
	}
	return Promise.promisify(github.repos.createRelease)(payload).then(result => {
		uploadUrl = result.data.upload_url;
		console.log("Created release: " + result.data.html_url)
	});
}

function UploadReleasePackage(){
	var fileSize = fs.statSync(packagePath).size;
	var packageContents = fs.readFileSync(packagePath);
	var payload = {
		url: uploadUrl,
		file: packageContents,
		contentType: "application/zip",
		contentLength: fileSize,
		name: packageFilename,
		label: "Download: " + packageFilename
	};
	return Promise.promisify(github.repos.uploadAsset)(payload)
		.then(result => console.log("Uploaded package: " + result.data.browser_download_url))
}

function CheckSteamPreviewExists(){
	if(!fs.existsSync(steamPreviewPath)){
		runner.fail("Steam preview not found at "+steamPreviewPath);
	}
}

var steamConfig = null;

function ReadSteamConfigFile(){
	try {
		steamConfig = JSON.parse(fs.readFileSync(steamConfigPath, {encoding: "utf8"}));
		if(!steamConfig.title||!steamConfig.description||!_.isNumber(steamConfig.visibility)) throw new Error("Required fields: title, description, visibility");
	} catch (err){
		runner.fail("Failed to read steam config file at "+steamConfigPath+": "+err)
	}
}

var steamFileId = null;

function ReadSteamFileId(){
	try {
		steamFileId = fs.readFileSync(steamFileIdFilePath, {encoding: "ascii"});
		if(parseInt(steamFileId, 10) != steamFileId) throw new Error("Invalid id: "+steamFileId);
	} catch (err){
		runner.fail("Could not read steam app id at " + steamFileIdFilePath + ": " + err)
	}
}

function CreateVDFFile(){
	var date = new Date();
	var vdf_data = {
		"workshopitem": {
			"appid": 294100,
			"contentfolder": modDirPath,
			"previewfile": steamPreviewPath,
			"visibility": steamConfig.visibility.toString(),
			"title": steamConfig.title,
			"description": steamConfig.description,
			"changenote": "Update on "+date.toDateString()+", "+date.getHours()+":"+date.getMinutes()+"\n\n"+commitMessage,
			"publishedfileid": steamFileId
		}
	};
	fs.writeFileSync(steamVDFFilePath, vdf.dump(vdf_data), 'utf-8');
}

function PublishSteamUpdate(){
	var username = readline.question("Enter Steam username: ");
	var pass = readline.question("Enter Steam password: ", {hideEchoBack: true});
	try {
		child_process.execSync(quote(steamCMDPath) + " +login " + username + " " + pass + " +workshop_build_item " + quote(steamVDFFilePath) + " +quit", {stdio: [0, 1, 2]});
	} catch (err){}
	console.log();
}

function CleanupVDFFile(){
	try {
		fs.unlink(steamVDFFilePath);
	} catch(err){}
}

function UpdateNuspecFile(){
	if(!fs.existsSync(nugetNuspecPath)){
		runner.fail("nuspec file not found at "+nugetNuspecPath);
		return;
	}
	replaceMatchedCaptureInFile(nugetNuspecPath, nuspecVersionPattern, currentVersion);
	replaceMatchedCaptureInFile(nugetNuspecPath, nuspecChangelogPattern, xmlEscape(commitMessage));
}

var nupkgFilePath = null;

function BuildNupkgFile(){
	child_process.execSync("nuget pack", {stdio: [0, 1, 2]});
	nupkgFilePath = findFileByExtension(workingDirectory, ".nupkg");
	if(!nupkgFilePath){
		runner.fail(".nupkg file not found after build");
	}
}

function CleanupNupkgFile(){
	try {
		fs.unlink(nupkgFilePath);
	} catch(err){}
}

function PushNugetPackage(){
	var apiKey = readTokenFile(nugetTokenPath);
	child_process.execSync("nuget push -Source nuget.org -ApiKey "+apiKey+" "+quote(nupkgFilePath), {stdio: [0, 1, 2]});
}

//////////////////////////////////////////// EXECUTION ////////////////////////////////////////////
var argCount = process.argv.slice(2).length;

currentVersion = readAssemblyVersion();
if(!cmd.skipPreChecks && argCount) {
	runner.addTask(EnsureIsModDirectory);
	runner.addTask(EnsureEverythingCommitted);
	runner.addTask(EnsureGitRemoteIsUpToDate);
}

if(cmd.incrementVersion){
	runner.addTask(IncrementVersion);
	runner.addTask(UpdateOverrideVersion);
	runner.addTask(UpdateAboutXmlVersion);
	runner.addTask(UpdateAssemblyInfo);
	runner.addTask(BuildAssembly);
}

if(cmd.github || cmd.steam || cmd.nuget){
	runner.addTask(FetchCommitMessage);
}

if(cmd.github) {
	runner.addTask(GetGitHubRepoPath);
	runner.addTask(CreateReleasePackage, null, [CleanupPackagedRelease]);
	runner.addTask(MakeGithubRelease);
	runner.addTask(UploadReleasePackage);
}
if(cmd.steam){
	runner.addTask(CreateVDFFile, [ReadSteamFileId, ReadSteamConfigFile, CheckSteamPreviewExists], [CleanupVDFFile])
	runner.addTask(PublishSteamUpdate);
}
if(cmd.nuget){
	runner.addTask(UpdateNuspecFile);
	runner.addTask(BuildNupkgFile, null, [CleanupNupkgFile]);
	runner.addTask(PushNugetPackage);
}

runner.run();

if (!argCount) {
	cmd.outputHelp();
}