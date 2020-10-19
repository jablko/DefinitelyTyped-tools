import applicationinsights = require("applicationinsights");
import search = require("libnpmsearch");
import { graphql } from "@octokit/graphql";
import * as yargs from "yargs";

import { defaultLocalOptions } from "./lib/common";
import { deprecateNotNeededPackage, publishNotNeededPackage, publishTypingsPackage } from "./lib/package-publisher";
import { getDefinitelyTyped, AllPackages } from "@definitelytyped/definitions-parser";
import {
  loggerWithErrors,
  logUncaughtErrors,
  logger,
  Fetcher,
  writeLog,
  NpmPublishClient,
  Registry,
  withNpmCache,
  UncachedNpmInfoClient
} from "@definitelytyped/utils";
import { readChangedPackages, ChangedPackages } from "./lib/versions";
import { skipBadPublishes } from "./lib/npm";
import { getSecret, Secret } from "./lib/secrets";
import { cacheDirPath } from "./lib/settings";

if (!module.parent) {
  const dry = !!yargs.argv.dry;
  const deprecateName = yargs.argv.deprecate as string | undefined;
  logUncaughtErrors(async () => {
    const dt = await getDefinitelyTyped(defaultLocalOptions, loggerWithErrors()[0]);
    if (deprecateName !== undefined) {
      // A '--deprecate' command is available in case types-publisher got stuck *while* trying to deprecate a package.
      // Normally this should not be needed.

      const log = logger()[0];
      try {
        await deprecateNotNeededPackage(
          await NpmPublishClient.create(
            await getSecret(Secret.GITHUB_PUBLISH_ACCESS_TOKEN),
            undefined,
            Registry.Github
          ),
          AllPackages.readSingleNotNeeded(deprecateName, dt),
          false /*dry*/,
          log
        );
      } catch (e) {
        // log and continue
        log("publishing to github failed: " + e.toString());
      }
      await deprecateNotNeededPackage(
        await NpmPublishClient.create(await getSecret(Secret.NPM_TOKEN), undefined, Registry.NPM),
        AllPackages.readSingleNotNeeded(deprecateName, dt),
        /*dry*/ false,
        log
      );
    } else {
      const allPackages = await AllPackages.read(dt);
      await publishPackages(
        allPackages,
        await readChangedPackages(allPackages),
        dry,
        process.env.GH_API_TOKEN || "",
        new Fetcher()
      );
    }
  });
}

export default async function publishPackages(
  allPackages: AllPackages,
  changedPackages: ChangedPackages,
  dry: boolean,
  githubAccessToken: string,
  fetcher: Fetcher
): Promise<void> {
  const [log, logResult] = logger();
  if (dry) {
    log("=== DRY RUN ===");
  } else {
    log("=== Publishing packages ===");
  }

  const client = await NpmPublishClient.create(await getSecret(Secret.NPM_TOKEN), undefined, Registry.NPM);
  const ghClient = await NpmPublishClient.create(
    await getSecret(Secret.GITHUB_PUBLISH_ACCESS_TOKEN),
    undefined,
    Registry.Github
  );

  for (const cp of changedPackages.changedTypings) {
    log(`Publishing ${cp.pkg.desc}...`);

    try {
      await publishTypingsPackage(ghClient, cp, dry, log, Registry.Github);
    } catch (e) {
      // log and continue
      log("publishing to github failed: " + e.toString());
    }
    await publishTypingsPackage(client, cp, dry, log, Registry.NPM);

    const commits = (await queryGithub(
      `repos/DefinitelyTyped/DefinitelyTyped/commits?path=types%2f${cp.pkg.subDirectoryPath}`,
      githubAccessToken,
      fetcher
    )) as {
      sha: string;
      commit: {
        message: string;
        author: {
          date: string;
        };
      };
    }[];

    const firstCommit = commits[0];
    if (firstCommit && !firstCommit.commit.message.includes("#no-publishing-comment")) {
      log("Found related commits; hash: " + commits[0].sha);
      const prs = (await queryGithub(
        `search/issues?q=is:pr%20is:merged%20${commits[0].sha}`,
        githubAccessToken,
        fetcher
      )) as { items: { number: number }[] };
      let latestPr = 0;
      for (const pr of prs.items) {
        if (pr.number > latestPr) {
          latestPr = pr.number;
        }
      }
      log("Latest PR: " + latestPr);
      if (latestPr === 0) {
        continue;
      }
      const latest = (await queryGithub(
        `repos/DefinitelyTyped/DefinitelyTyped/pulls/${latestPr}`,
        githubAccessToken,
        fetcher
      )) as { merged_at: string };
      const latency = Date.now() - new Date(latest.merged_at).valueOf();
      const commitlatency = Date.now() - new Date(commits[0].commit.author.date).valueOf();
      log("Current date is " + new Date(Date.now()).toString());
      log("  Merge date is " + new Date(latest.merged_at).toString());

      const published = cp.pkg.fullNpmName + "@" + cp.version;
      const publishNotification =
        "I just published [`" + published + "` to npm](https://www.npmjs.com/package/" + cp.pkg.fullNpmName + ").";
      log(publishNotification);
      if (dry) {
        log("(dry) Skip publishing notification to github.");
      } else {
        const commented = await postGithub(
          `repos/DefinitelyTyped/DefinitelyTyped/issues/${latestPr}/comments`,
          { body: publishNotification },
          githubAccessToken,
          fetcher
        );
        log("From github: " + JSON.stringify(commented).slice(0, 200));
      }
      if (dry) {
        log("(dry) Not logging latency");
      } else {
        applicationinsights.defaultClient.trackEvent({
          name: "publish package",
          properties: {
            name: cp.pkg.desc,
            latency: latency.toString(),
            commitLatency: commitlatency.toString(),
            authorCommit: commits[0].sha,
            pr: latestPr.toString()
          }
        });
        applicationinsights.defaultClient.trackMetric({ name: "publish latency", value: latency });
        applicationinsights.defaultClient.trackMetric({ name: "author commit latency", value: commitlatency });
        log("Done logging latency");
      }
    }
  }

  await withNpmCache(
    new UncachedNpmInfoClient(),
    async infoClient => {
      for (const n of changedPackages.changedNotNeededPackages) {
        const target = skipBadPublishes(n, infoClient, log);
        try {
          await publishNotNeededPackage(ghClient, target, dry, log, Registry.Github);
        } catch (e) {
          // log and continue
          log("publishing to github failed: " + e.toString());
        }
        await publishNotNeededPackage(client, target, dry, log, Registry.NPM);
      }
    },
    cacheDirPath
  );

  // Loop over the @types packages in npm and mark any that no longer
  // exist in HEAD as deprecated.
  let from = 0;
  let objects;
  do {
    const opts = {
      limit: 250,
      from
    };
    objects = await search("@types", opts);
    for (const { name: fullNpmName } of objects) {
      const name = fullNpmName.slice("@types/".length);
      // If they don't exist in the types directory or in
      // notNeededPackages.json then mark them deprecated. Reference the
      // commit/pull request that removed them.
      if (!allPackages.tryGetLatestVersion(name) && !allPackages.getNotNeededPackage(name)) {
        log(`Deprecating ${name}`);
        const {
          repository: {
            ref: {
              target: {
                history: {
                  nodes: [commit]
                }
              }
            }
          }
        } = await graphql(
          `
            query($path: String!) {
              repository(name: "DefinitelyTyped", owner: "DefinitelyTyped") {
                ref(qualifiedName: "master") {
                  target {
                    ... on Commit {
                      history(first: 1, path: $path) {
                        nodes {
                          associatedPullRequests(first: 1) {
                            nodes {
                              url
                            }
                          }
                          messageHeadline
                        }
                      }
                    }
                  }
                }
              }
            }
          `,
          {
            headers: { authorization: `token ${githubAccessToken}` },
            path: `types/${name}`
          }
        );
        let deprecatedMessage;
        if (commit) {
          const {
            associatedPullRequests: {
              nodes: [pullRequest]
            },
            messageHeadline
          } = commit;
          deprecatedMessage = messageHeadline;
          if (pullRequest) {
            deprecatedMessage += ` (${pullRequest.url})`;
          }
        }
        if (dry) {
          log(`(dry) Skip deprecate removed package ${fullNpmName}`);
        } else {
          log(`Deprecating ${fullNpmName} with message: ${deprecatedMessage}`);
          await client.deprecate(fullNpmName, "", deprecatedMessage);
        }
      }
    }
    from += objects.length;
  } while (objects.length >= 250 && from <= 5000);

  await writeLog("publishing.md", logResult());
  console.log("Done!");
}

async function postGithub(path: string, data: any, githubToken: string, fetcher: Fetcher) {
  const [log] = logger();
  const body = JSON.stringify(data);
  log(`Posting to github at ${path}: ${body}`);
  return fetcher.fetchJson({
    hostname: "api.github.com",
    method: "POST",
    path,
    body,
    headers: {
      // arbitrary string, but something must be provided
      "User-Agent": "types-publisher",
      "Content-Type": "application/json",
      Authorization: "token " + githubToken,
      "Content-Length": Buffer.byteLength(body)
    }
  });
}

async function queryGithub(path: string, githubToken: string, fetcher: Fetcher) {
  const [log] = logger();
  log("Requesting from github: " + path);
  return fetcher.fetchJson({
    hostname: "api.github.com",
    method: "GET",
    path: path + "&access_token=" + githubToken,
    headers: {
      // arbitrary string, but something must be provided
      "User-Agent": "types-publisher"
    }
  });
}
