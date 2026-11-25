//! The PRs & builds pane: a repository's open pull requests, with their checks
//! and votes, and the recent runs of its pipelines.
//!
//! The provider comes from the git remote, the same way the build badge finds
//! its coordinates: an Azure DevOps remote talks to Azure DevOps with the az
//! CLI's login, a GitHub remote talks to GitHub with the gh CLI's. Either way
//! there's nothing to configure and no token to store.

use crate::builds::{self, Builds, Coords};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// The pane refreshes once a minute while it's showing; anything sooner is
/// served from here unless the ⟳ button asks for fresh.
const ACTIVITY_TTL: Duration = Duration::from_secs(60);
/// gh tokens don't expire on a timer, but a re-login replaces them.
const TOKEN_TTL: Duration = Duration::from_secs(20 * 60);
/// Each PR costs a request or two for its checks, so keep the list bounded.
const MAX_PRS: usize = 25;
const MAX_PIPELINES: usize = 6;
const RUNS_PER_PIPELINE: usize = 10;

/* ------------------------------------------------------------------- model */

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    /// `azure`, `github`, or `none` when no remote points at either.
    pub provider: String,
    /// `Enlighten / Enlighten Internal / Job` or `owner / repo`.
    pub source: String,
    /// The remote it came from: `origin → https://…`.
    pub remote: String,
    /// The repository's web page, for building "new PR" links.
    pub repo_url: String,
    pub default_branch: String,
    pub prs: Vec<Pr>,
    pub pipelines: Vec<Pipeline>,
    /// Set when the provider couldn't be asked: no login, no access.
    pub error: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pr {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub author: String,
    /// Opened by whoever az or gh is logged in as.
    pub mine: bool,
    /// You're a reviewer and haven't voted yet.
    pub review_requested: bool,
    pub source_branch: String,
    pub target_branch: String,
    pub draft: bool,
    pub conflicts: bool,
    pub created: String,
    pub reviewers: Vec<Reviewer>,
    pub checks: Vec<Check>,
    /// Every blocking check passes: it could be completed or merged now.
    pub ready: bool,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reviewer {
    pub name: String,
    /// approved, suggestions, waiting, rejected or none.
    pub vote: String,
    pub me: bool,
    pub required: bool,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub name: String,
    /// `build` for a pipeline or check run, `policy` for everything else a
    /// branch policy wants (reviewer counts, comments, work items).
    pub kind: String,
    /// succeeded, failed, running, queued, expired, canceled or skipped.
    pub state: String,
    pub detail: String,
    pub url: String,
    pub blocking: bool,
    /// Azure's build definition, so a policy with no display name of its own
    /// can borrow its pipeline's.
    #[serde(skip)]
    definition: Option<u64>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pipeline {
    pub name: String,
    pub url: String,
    /// Newest first.
    pub runs: Vec<Run>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    /// The provider's id for the run; Azure's build ids rise with queue order.
    pub id: u64,
    /// Azure's build definition, so release tracking can find its pipeline.
    pub definition: Option<u64>,
    /// As for checks, plus `waiting`: held at an approval gate.
    pub state: String,
    pub number: String,
    pub branch: String,
    pub url: String,
    pub time: Option<String>,
    /// Waiting on an approval that you're one of the approvers for.
    pub can_approve: bool,
}

impl Activity {
    fn failed(provider: &str, source: String, remote: String, error: impl Into<String>) -> Self {
        Activity {
            provider: provider.into(),
            source,
            remote,
            error: Some(error.into()),
            ..Default::default()
        }
    }
}

/* ------------------------------------------------------------------- cache */

#[derive(Default)]
pub struct Prs {
    inner: Mutex<PrCache>,
}

#[derive(Default)]
struct PrCache {
    /// Project path to its last answer.
    latest: HashMap<String, (Instant, Activity)>,
    /// Who az or gh is logged in as, per Azure org (or `github`).
    me: HashMap<String, String>,
    /// Azure `org/project/repo` to what the repository lookup said.
    repos: HashMap<String, AzureRepo>,
    gh_token: Option<(String, Instant)>,
}

#[derive(Clone)]
struct AzureRepo {
    id: String,
    project_id: String,
    web_url: String,
    default_branch: String,
}

/* ----------------------------------------------------------------- remotes */

#[derive(Clone, Debug, PartialEq)]
struct GitHubRepo {
    owner: String,
    repo: String,
}

enum Remote {
    Azure(Coords),
    GitHub(GitHubRepo),
}

/// GitHub remotes in https, scp-style and ssh:// form.
fn parse_github(raw: &str) -> Option<GitHubRepo> {
    let url = raw.trim().trim_end_matches('/');
    let url = url.strip_suffix(".git").unwrap_or(url);
    let path = if let Some(rest) = url.strip_prefix("git@github.com:") {
        rest
    } else {
        let rest = url.split_once("://").map(|(_, r)| r)?;
        let (authority, path) = rest.split_once('/')?;
        let host = authority.rsplit('@').next()?.split(':').next()?.to_lowercase();
        if host != "github.com" && host != "www.github.com" {
            return None;
        }
        path
    };
    let mut parts = path.split('/').filter(|s| !s.is_empty());
    let owner = parts.next()?.to_string();
    let repo = parts.next()?.to_string();
    Some(GitHubRepo { owner, repo })
}

/// `origin` first, Azure before GitHub on the same remote, then any other
/// remote that points at either. A GitHub-origin repo that builds in Azure is
/// an Azure repo for this pane, as it is for the build badge.
fn detect(cwd: &Path) -> Option<(Remote, String)> {
    let mut remotes = builds::git_remotes(cwd);
    remotes.sort_by_key(|(name, _)| name.as_str() != "origin");
    let label = |name: &str, url: &str| format!("{name} → {url}");
    remotes
        .iter()
        .find_map(|(name, url)| builds::parse_remote(url).map(|c| (Remote::Azure(c), label(name, url))))
        .or_else(|| {
            remotes
                .iter()
                .find_map(|(name, url)| parse_github(url).map(|g| (Remote::GitHub(g), label(name, url))))
        })
}

/* ---------------------------------------------------------------- helpers */

fn text(node: &Value, key: &str) -> String {
    node.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn at<'a>(node: &'a Value, path: &[&str]) -> &'a Value {
    path.iter().fold(node, |n, key| n.get(key).unwrap_or(&Value::Null))
}

fn items(value: &Value) -> Vec<Value> {
    let list = value.get("value").unwrap_or(value);
    list.as_array().cloned().unwrap_or_default()
}

/// `refs/heads/main` is `main`; a PR's merge ref is `PR 8427`.
fn short_ref(name: &str) -> String {
    if let Some(rest) = name.strip_prefix("refs/pull/") {
        return format!("PR {}", rest.split('/').next().unwrap_or(rest));
    }
    name.strip_prefix("refs/heads/").unwrap_or(name).to_string()
}

/// Groups runs, newest first, into one row per pipeline in order of each
/// pipeline's latest run.
fn group_runs(runs: Vec<(String, String, Run)>) -> Vec<Pipeline> {
    let mut pipelines: Vec<Pipeline> = Vec::new();
    for (name, url, run) in runs {
        if let Some(p) = pipelines.iter_mut().find(|p| p.name == name) {
            if p.runs.len() < RUNS_PER_PIPELINE {
                p.runs.push(run);
            }
        } else if pipelines.len() < MAX_PIPELINES {
            pipelines.push(Pipeline {
                name,
                url,
                runs: vec![run],
            });
        }
    }
    pipelines
}

/// A PR could be completed now: nothing blocking is short of passing.
fn compute_ready(pr: &Pr) -> bool {
    if pr.draft || pr.conflicts {
        return false;
    }
    let passing = |c: &Check| matches!(c.state.as_str(), "succeeded" | "skipped");
    if pr.checks.iter().any(|c| c.kind == "policy") {
        // Azure's policies already say what "enough approvals" means here.
        return pr.checks.iter().filter(|c| c.blocking).all(passing);
    }
    let approved = pr.reviewers.iter().any(|r| r.vote == "approved" || r.vote == "suggestions");
    let rejected = pr.reviewers.iter().any(|r| r.vote == "rejected" || r.vote == "waiting");
    approved && !rejected && pr.checks.iter().all(passing)
}

/* ------------------------------------------------------------------- azure */

fn azure_vote(vote: i64) -> &'static str {
    match vote {
        10 => "approved",
        5 => "suggestions",
        -5 => "waiting",
        -10 => "rejected",
        _ => "none",
    }
}

fn azure_build_state(status: &str, result: &str) -> &'static str {
    match status {
        "inProgress" => "running",
        "notStarted" | "postponed" => "queued",
        "completed" => match result {
            "succeeded" => "succeeded",
            "failed" => "failed",
            "partiallySucceeded" => "partial",
            "canceled" => "canceled",
            _ => "unknown",
        },
        _ => "unknown",
    }
}

async fn azure_repo(cache: &Prs, coords: &Coords, token: &str) -> Result<AzureRepo, String> {
    let key = format!("{}/{}/{}", coords.org, coords.project, coords.repo);
    if let Some(repo) = cache.inner.lock().ok().and_then(|g| g.repos.get(&key).cloned()) {
        return Ok(repo);
    }
    let url = format!(
        "{}/{}/_apis/git/repositories/{}?api-version=7.1",
        coords.org_url(),
        builds::encode(&coords.project),
        builds::encode(&coords.repo),
    );
    let value = builds::get_json(&url, token).await?;
    let repo = AzureRepo {
        id: text(&value, "id"),
        project_id: text(at(&value, &["project"]), "id"),
        web_url: text(&value, "webUrl"),
        default_branch: short_ref(&text(&value, "defaultBranch")),
    };
    if repo.id.is_empty() {
        return Err("repository not found in that project".into());
    }
    if let Ok(mut guard) = cache.inner.lock() {
        guard.repos.insert(key, repo.clone());
    }
    Ok(repo)
}

async fn azure_me(cache: &Prs, coords: &Coords, token: &str) -> String {
    if let Some(id) = cache.inner.lock().ok().and_then(|g| g.me.get(&coords.org).cloned()) {
        return id;
    }
    let url = format!("{}/_apis/connectionData", coords.org_url());
    let id = builds::get_json(&url, token)
        .await
        .map(|v| text(at(&v, &["authenticatedUser"]), "id"))
        .unwrap_or_default();
    if !id.is_empty() {
        if let Ok(mut guard) = cache.inner.lock() {
            guard.me.insert(coords.org.clone(), id.clone());
        }
    }
    id
}

/// Branch policy evaluations for one PR: the build validation, reviewer
/// counts, comment resolution and work item linking, as the PR page shows them.
async fn azure_checks(org_url: String, project: String, project_id: String, pr: u64, token: String) -> Vec<Check> {
    let url = format!(
        "{org_url}/{}/_apis/policy/evaluations?artifactId={}&api-version=7.1-preview.1",
        builds::encode(&project),
        builds::encode(&format!("vstfs:///CodeReview/CodeReviewId/{project_id}/{pr}")),
    );
    let Ok(value) = builds::get_json(&url, &token).await else {
        return Vec::new();
    };
    items(&value)
        .iter()
        .filter_map(|e| {
            let config = at(e, &["configuration"]);
            if config.get("isEnabled").and_then(Value::as_bool) == Some(false) {
                return None;
            }
            let status = text(e, "status");
            if status == "notApplicable" {
                return None;
            }
            let kind_name = text(at(config, &["type"]), "displayName");
            let is_build = kind_name == "Build";
            let context = at(e, &["context"]);
            let expired = context.get("isExpired").and_then(Value::as_bool) == Some(true);
            let state = match status.as_str() {
                "approved" => "succeeded",
                "rejected" | "broken" => "failed",
                "running" => "running",
                _ if expired => "expired",
                _ => "queued",
            };
            let name = [
                text(at(config, &["settings"]), "displayName"),
                text(context, "buildDefinitionName"),
                kind_name.clone(),
            ]
            .into_iter()
            .find(|n| !n.is_empty())
            .unwrap_or_else(|| "Policy".into());
            // No build yet (say, blocked on conflicts) reads as id 0.
            let build_id = context.get("buildId").and_then(Value::as_u64).filter(|id| *id > 0);
            // Where a failed build stopped and why, as the PR page previews it.
            let preview = at(context, &["buildOutputPreview"]);
            let failure = [
                text(preview, "taskName"),
                at(preview, &["errors"])
                    .as_array()
                    .and_then(|errors| errors.first())
                    .map(|e| text(e, "message"))
                    .unwrap_or_default(),
            ]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(": ");
            let detail = if is_build {
                failure.chars().take(160).collect()
            } else if kind_name == name {
                String::new()
            } else {
                kind_name
            };
            Some(Check {
                name,
                kind: if is_build { "build" } else { "policy" }.into(),
                state: state.into(),
                detail,
                url: build_id
                    .map(|id| format!("{org_url}/{}/_build/results?buildId={id}", builds::encode(&project)))
                    .unwrap_or_default(),
                blocking: config.get("isBlocking").and_then(Value::as_bool).unwrap_or(true),
                definition: at(config, &["settings", "buildDefinitionId"]).as_u64().filter(|id| *id > 0),
            })
        })
        .collect()
}

async fn azure(cache: &Prs, builds_state: &Builds, coords: Coords, remote: String) -> Activity {
    let source = coords.label();
    let fail = |e: String| Activity::failed("azure", source.clone(), remote.clone(), e);
    let token = match builds::az_token(&builds_state.inner) {
        Ok(t) => t,
        Err(e) => return fail(e),
    };
    let repo = match azure_repo(cache, &coords, &token).await {
        Ok(r) => r,
        Err(e) => return fail(e),
    };
    let me = azure_me(cache, &coords, &token).await;
    let org_url = coords.org_url();
    let project = builds::encode(&coords.project);

    let prs_url = format!(
        "{org_url}/{project}/_apis/git/repositories/{}/pullrequests?searchCriteria.status=active&$top={MAX_PRS}&api-version=7.1",
        repo.id
    );
    let runs_url = format!(
        "{org_url}/{project}/_apis/build/builds?repositoryId={}&repositoryType=TfsGit&queryOrder=queueTimeDescending&$top=60&api-version=7.1",
        repo.id
    );
    let (prs_value, runs_value) = (
        builds::get_json(&prs_url, &token).await,
        builds::get_json(&runs_url, &token).await,
    );
    let prs_value = match prs_value {
        Ok(v) => v,
        Err(e) => return fail(e),
    };

    let mut prs: Vec<Pr> = items(&prs_value)
        .iter()
        .map(|p| {
            let number = p.get("pullRequestId").and_then(Value::as_u64).unwrap_or_default();
            let author = at(p, &["createdBy"]);
            let reviewers: Vec<Reviewer> = p
                .get("reviewers")
                .and_then(Value::as_array)
                .map(|list| {
                    list.iter()
                        // Groups and teams aren't people with a face to show.
                        .filter(|r| r.get("isContainer").and_then(Value::as_bool) != Some(true))
                        .map(|r| Reviewer {
                            name: text(r, "displayName"),
                            vote: azure_vote(r.get("vote").and_then(Value::as_i64).unwrap_or(0)).into(),
                            me: !me.is_empty() && text(r, "id") == me,
                            required: r.get("isRequired").and_then(Value::as_bool).unwrap_or(false),
                        })
                        .collect()
                })
                .unwrap_or_default();
            Pr {
                number,
                title: text(p, "title"),
                url: format!("{}/pullrequest/{number}", repo.web_url),
                author: text(author, "displayName"),
                mine: !me.is_empty() && text(author, "id") == me,
                review_requested: reviewers.iter().any(|r| r.me && r.vote == "none"),
                source_branch: short_ref(&text(p, "sourceRefName")),
                target_branch: short_ref(&text(p, "targetRefName")),
                draft: p.get("isDraft").and_then(Value::as_bool).unwrap_or(false),
                conflicts: text(p, "mergeStatus") == "conflicts",
                created: text(p, "creationDate"),
                reviewers,
                ..Default::default()
            }
        })
        .collect();

    // One policy request per PR, all at once.
    let handles: Vec<_> = prs
        .iter()
        .map(|pr| {
            tauri::async_runtime::spawn(azure_checks(
                org_url.clone(),
                coords.project.clone(),
                repo.project_id.clone(),
                pr.number,
                token.clone(),
            ))
        })
        .collect();
    let runs_value = runs_value.unwrap_or_default();
    // Build policies often have no display name; their pipeline's will do.
    let definitions: HashMap<u64, String> = items(&runs_value)
        .iter()
        .filter_map(|b| {
            let d = at(b, &["definition"]);
            Some((d.get("id")?.as_u64()?, text(d, "name")))
        })
        .collect();
    for (pr, handle) in prs.iter_mut().zip(handles) {
        pr.checks = handle.await.unwrap_or_default();
        for check in pr.checks.iter_mut().filter(|c| c.kind == "build" && c.name == "Build") {
            if let Some(name) = check.definition.and_then(|d| definitions.get(&d)) {
                check.name = name.clone();
            }
        }
        pr.ready = compute_ready(pr);
    }

    // Runs held at an approval gate read as in progress; ask which they are,
    // but only when something is in progress at all.
    let in_progress = items(&runs_value).iter().any(|b| text(b, "status") == "inProgress");
    let waiting = if in_progress {
        builds::pending_approvals(&org_url, &coords.project, &token).await
    } else {
        HashMap::new()
    };

    let runs = Some(runs_value)
        .map(|v| {
            items(&v)
                .iter()
                .map(|b| {
                    let id = b.get("id").and_then(Value::as_u64).unwrap_or_default();
                    let approvers = waiting.get(&id).filter(|_| text(b, "status") == "inProgress");
                    let definition = at(b, &["definition"]);
                    let name = text(definition, "name");
                    let url = definition
                        .get("id")
                        .and_then(Value::as_u64)
                        .map(|id| format!("{org_url}/{project}/_build?definitionId={id}"))
                        .unwrap_or_default();
                    let run = Run {
                        id,
                        definition: definition.get("id").and_then(Value::as_u64),
                        state: if approvers.is_some() {
                            "waiting"
                        } else {
                            azure_build_state(&text(b, "status"), &text(b, "result"))
                        }
                        .into(),
                        number: text(b, "buildNumber"),
                        branch: short_ref(&text(b, "sourceBranch")),
                        url: text(at(b, &["_links", "web"]), "href"),
                        time: ["finishTime", "startTime", "queueTime"]
                            .iter()
                            .map(|k| text(b, k))
                            .find(|t| !t.is_empty()),
                        can_approve: !me.is_empty() && approvers.is_some_and(|a| a.contains(&me)),
                    };
                    (name, url, run)
                })
                .collect()
        })
        .unwrap_or_default();

    Activity {
        provider: "azure".into(),
        source,
        remote,
        repo_url: repo.web_url,
        default_branch: repo.default_branch,
        prs,
        pipelines: group_runs(runs),
        error: None,
    }
}

/* ------------------------------------------------------------------ github */

fn gh_token(cache: &Prs) -> Result<String, String> {
    if let Some((token, fetched)) = cache.inner.lock().ok().and_then(|g| g.gh_token.clone()) {
        if fetched.elapsed() < TOKEN_TTL {
            return Ok(token);
        }
    }
    let mut cmd = Command::new("gh");
    cmd.args(["auth", "token", "--hostname", "github.com"]);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let out = cmd
        .output()
        .map_err(|_| "the gh CLI isn't installed — it's how GitHub repos sign in".to_string())?;
    let token = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !out.status.success() || token.is_empty() {
        return Err("gh has no login — run `gh auth login`".into());
    }
    if let Ok(mut guard) = cache.inner.lock() {
        guard.gh_token = Some((token.clone(), Instant::now()));
    }
    Ok(token)
}

async fn gh_get(url: String, token: String) -> Result<Value, String> {
    let response = builds::client()
        .get(&url)
        .bearer_auth(&token)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", "butpicker")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status().as_u16();
    let body = response.text().await.map_err(|e| e.to_string())?;
    match status {
        200..=299 => serde_json::from_str(&body).map_err(|e| format!("unreadable response: {e}")),
        401 => Err("GitHub rejected the gh token — run `gh auth login`".into()),
        403 | 429 => Err("GitHub refused: rate limited or no access".into()),
        404 => Err("not found — or gh's login can't see this repository".into()),
        _ => Err(format!("GitHub returned {status}")),
    }
}

fn gh_state(status: &str, conclusion: &str) -> &'static str {
    match status {
        "completed" => match conclusion {
            "success" => "succeeded",
            "failure" | "timed_out" | "startup_failure" => "failed",
            "cancelled" => "canceled",
            "neutral" | "skipped" | "stale" => "skipped",
            "action_required" => "queued",
            _ => "unknown",
        },
        "in_progress" => "running",
        // A deployment held for review, as Azure's approvals are.
        "waiting" => "waiting",
        _ => "queued",
    }
}

/// A PR's reviews and its head commit's check runs.
async fn gh_pr_detail(api: String, number: u64, sha: String, me: String, token: String) -> (Vec<Reviewer>, Vec<Check>) {
    let reviews = gh_get(format!("{api}/pulls/{number}/reviews?per_page=100"), token.clone());
    let runs = gh_get(format!("{api}/commits/{sha}/check-runs?per_page=50"), token);
    let (reviews, runs) = (reviews.await, runs.await);

    // A reviewer's latest decisive review is their vote; comments don't change it.
    let mut reviewers: Vec<Reviewer> = Vec::new();
    for r in reviews.map(|v| items(&v)).unwrap_or_default() {
        let login = text(at(&r, &["user"]), "login");
        let vote = match text(&r, "state").as_str() {
            "APPROVED" => "approved",
            "CHANGES_REQUESTED" => "rejected",
            "DISMISSED" => "none",
            _ => continue,
        };
        match reviewers.iter_mut().find(|x| x.name == login) {
            Some(existing) => existing.vote = vote.into(),
            None => reviewers.push(Reviewer {
                me: login == me,
                name: login,
                vote: vote.into(),
                required: false,
            }),
        }
    }

    let checks = runs
        .map(|v| {
            at(&v, &["check_runs"])
                .as_array()
                .cloned()
                .unwrap_or_default()
                .iter()
                .map(|c| Check {
                    name: text(c, "name"),
                    kind: "build".into(),
                    state: gh_state(&text(c, "status"), &text(c, "conclusion")).into(),
                    detail: String::new(),
                    url: text(c, "html_url"),
                    blocking: true,
                    definition: None,
                })
                .collect()
        })
        .unwrap_or_default();
    (reviewers, checks)
}

async fn github(cache: &Prs, repo: GitHubRepo, remote: String) -> Activity {
    let source = format!("{} / {}", repo.owner, repo.repo);
    let fail = |e: String| Activity::failed("github", source.clone(), remote.clone(), e);
    let token = match gh_token(cache) {
        Ok(t) => t,
        Err(e) => return fail(e),
    };
    let api = format!("https://api.github.com/repos/{}/{}", repo.owner, repo.repo);

    let me = match cache.inner.lock().ok().and_then(|g| g.me.get("github").cloned()) {
        Some(login) => login,
        None => {
            let login = gh_get("https://api.github.com/user".into(), token.clone())
                .await
                .map(|v| text(&v, "login"))
                .unwrap_or_default();
            if let Ok(mut guard) = cache.inner.lock() {
                guard.me.insert("github".into(), login.clone());
            }
            login
        }
    };

    let info = gh_get(api.clone(), token.clone());
    let pulls = gh_get(format!("{api}/pulls?state=open&per_page={MAX_PRS}"), token.clone());
    let runs = gh_get(format!("{api}/actions/runs?per_page=60"), token.clone());
    let (info, pulls, runs) = (info.await, pulls.await, runs.await);
    let info = match info {
        Ok(v) => v,
        Err(e) => return fail(e),
    };
    let repo_url = text(&info, "html_url");
    let pulls = match pulls {
        Ok(v) => items(&v),
        Err(e) => return fail(e),
    };

    let handles: Vec<_> = pulls
        .iter()
        .map(|p| {
            tauri::async_runtime::spawn(gh_pr_detail(
                api.clone(),
                p.get("number").and_then(Value::as_u64).unwrap_or_default(),
                text(at(p, &["head"]), "sha"),
                me.clone(),
                token.clone(),
            ))
        })
        .collect();

    let mut prs = Vec::new();
    for (p, handle) in pulls.iter().zip(handles) {
        let (mut reviewers, checks) = handle.await.unwrap_or_default();
        let requested: Vec<String> = at(p, &["requested_reviewers"])
            .as_array()
            .map(|l| l.iter().map(|r| text(r, "login")).collect())
            .unwrap_or_default();
        // Asked but not yet answered: shown, with no vote.
        for login in &requested {
            if !reviewers.iter().any(|r| &r.name == login) {
                reviewers.push(Reviewer {
                    me: *login == me,
                    name: login.clone(),
                    vote: "none".into(),
                    required: false,
                });
            }
        }
        let author = text(at(p, &["user"]), "login");
        let mut pr = Pr {
            number: p.get("number").and_then(Value::as_u64).unwrap_or_default(),
            title: text(p, "title"),
            url: text(p, "html_url"),
            mine: !me.is_empty() && author == me,
            author,
            review_requested: requested.iter().any(|r| *r == me),
            source_branch: text(at(p, &["head"]), "ref"),
            target_branch: text(at(p, &["base"]), "ref"),
            draft: p.get("draft").and_then(Value::as_bool).unwrap_or(false),
            conflicts: false,
            created: text(p, "created_at"),
            reviewers,
            checks,
            ready: false,
        };
        pr.ready = compute_ready(&pr);
        prs.push(pr);
    }

    let runs = runs
        .map(|v| {
            at(&v, &["workflow_runs"])
                .as_array()
                .cloned()
                .unwrap_or_default()
                .iter()
                .map(|r| {
                    let file = text(r, "path");
                    let file = file.rsplit('/').next().unwrap_or_default();
                    let run = Run {
                        id: r.get("id").and_then(Value::as_u64).unwrap_or_default(),
                        definition: None,
                        state: gh_state(&text(r, "status"), &text(r, "conclusion")).into(),
                        number: r
                            .get("run_number")
                            .and_then(Value::as_u64)
                            .map(|n| format!("#{n}"))
                            .unwrap_or_default(),
                        branch: text(r, "head_branch"),
                        url: text(r, "html_url"),
                        time: Some(text(r, "updated_at")).filter(|t| !t.is_empty()),
                        can_approve: false,
                    };
                    (text(r, "name"), format!("{repo_url}/actions/workflows/{file}"), run)
                })
                .collect()
        })
        .unwrap_or_default();

    Activity {
        provider: "github".into(),
        source,
        remote,
        default_branch: text(&info, "default_branch"),
        repo_url,
        prs,
        pipelines: group_runs(runs),
        error: None,
    }
}

/* ----------------------------------------------------------------- command */

/// The PRs & builds pane's data for one project. Cached for a minute; `force`
/// is the ⟳ button.
#[tauri::command]
pub async fn repo_activity(
    prs: tauri::State<'_, Prs>,
    builds_state: tauri::State<'_, Builds>,
    path: String,
    force: bool,
) -> Result<Activity, String> {
    if !force {
        if let Some((fetched, activity)) = prs.inner.lock().ok().and_then(|g| g.latest.get(&path).cloned()) {
            if fetched.elapsed() < ACTIVITY_TTL {
                return Ok(activity);
            }
        }
    }

    let cwd = Path::new(&path);
    let activity = match if cwd.is_dir() { detect(cwd) } else { None } {
        Some((Remote::Azure(coords), remote)) => azure(&prs, &builds_state, coords, remote).await,
        Some((Remote::GitHub(repo), remote)) => github(&prs, repo, remote).await,
        None => Activity {
            provider: "none".into(),
            error: Some("No Azure DevOps or GitHub remote on this repository.".into()),
            ..Default::default()
        },
    };

    if let Ok(mut guard) = prs.inner.lock() {
        guard.latest.insert(path, (Instant::now(), activity.clone()));
    }
    Ok(activity)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gh(remote: &str) -> Option<(String, String)> {
        parse_github(remote).map(|g| (g.owner, g.repo))
    }

    #[test]
    fn parses_github_remotes() {
        let want = Some(("bzbetty".to_string(), "butpicker".to_string()));
        assert_eq!(gh("git@github.com:bzbetty/butpicker.git"), want);
        assert_eq!(gh("https://github.com/bzbetty/butpicker.git"), want);
        assert_eq!(gh("https://github.com/bzbetty/butpicker"), want);
        assert_eq!(gh("ssh://git@github.com/bzbetty/butpicker.git"), want);
        assert_eq!(gh("https://user@github.com/bzbetty/butpicker/"), want);
    }

    #[test]
    fn ignores_remotes_that_are_not_github() {
        assert_eq!(gh("https://dev.azure.com/Enlighten/Internal/_git/Job"), None);
        assert_eq!(gh("https://gitlab.com/a/b.git"), None);
        assert_eq!(gh("C:\\git\\mirror"), None);
    }

    #[test]
    fn shortens_refs() {
        assert_eq!(short_ref("refs/heads/feature/x"), "feature/x");
        assert_eq!(short_ref("refs/pull/8427/merge"), "PR 8427");
        assert_eq!(short_ref("main"), "main");
    }

    #[test]
    fn groups_runs_by_pipeline_newest_first() {
        let run = |n: &str| Run {
            number: n.into(),
            ..Default::default()
        };
        let grouped = group_runs(vec![
            ("CI".into(), "u1".into(), run("3")),
            ("Deploy".into(), "u2".into(), run("2")),
            ("CI".into(), "u1".into(), run("1")),
        ]);
        assert_eq!(grouped.len(), 2);
        assert_eq!(grouped[0].name, "CI");
        assert_eq!(grouped[0].runs.iter().map(|r| r.number.as_str()).collect::<Vec<_>>(), ["3", "1"]);
    }

    #[test]
    fn ready_needs_every_blocking_policy() {
        let check = |kind: &str, state: &str, blocking: bool| Check {
            kind: kind.into(),
            state: state.into(),
            blocking,
            ..Default::default()
        };
        let mut pr = Pr {
            checks: vec![check("build", "succeeded", true), check("policy", "succeeded", true)],
            ..Default::default()
        };
        assert!(compute_ready(&pr));
        pr.checks.push(check("policy", "queued", false));
        assert!(compute_ready(&pr), "optional policies don't block");
        pr.checks.push(check("build", "failed", true));
        assert!(!compute_ready(&pr));
    }

    #[test]
    fn ready_without_policies_wants_an_approval_and_green_checks() {
        let mut pr = Pr {
            checks: vec![Check {
                kind: "build".into(),
                state: "succeeded".into(),
                blocking: true,
                ..Default::default()
            }],
            ..Default::default()
        };
        assert!(!compute_ready(&pr), "no approval yet");
        pr.reviewers.push(Reviewer {
            vote: "approved".into(),
            ..Default::default()
        });
        assert!(compute_ready(&pr));
        pr.draft = true;
        assert!(!compute_ready(&pr));
    }
}

/// Live check against real repos: `PRS_PATHS="C:\git\a;C:\git\b" cargo test --lib live -- --ignored --nocapture`.
#[cfg(test)]
mod live {
    use super::*;

    #[test]
    #[ignore]
    fn live() {
        let paths = std::env::var("PRS_PATHS").unwrap_or_default();
        let prs = Prs::default();
        let builds_state = Builds::default();
        for path in paths.split(';').filter(|p| !p.is_empty()) {
            let activity = tauri::async_runtime::block_on(async {
                match detect(Path::new(path)) {
                    Some((Remote::Azure(c), r)) => azure(&prs, &builds_state, c, r).await,
                    Some((Remote::GitHub(g), r)) => github(&prs, g, r).await,
                    None => Activity::default(),
                }
            });
            println!("== {path}: {} {} err={:?}", activity.provider, activity.source, activity.error);
            if let Ok(out) = std::env::var("PRS_JSON") {
                std::fs::write(out, serde_json::to_string_pretty(&activity).unwrap()).unwrap();
            }
            for pr in &activity.prs {
                println!(
                    "  PR {} {:?} by {} mine={} req={} ready={} conflicts={} {}->{}",
                    pr.number, pr.title, pr.author, pr.mine, pr.review_requested, pr.ready, pr.conflicts,
                    pr.source_branch, pr.target_branch
                );
                for r in &pr.reviewers {
                    println!("    reviewer {} {} me={}", r.name, r.vote, r.me);
                }
                for c in &pr.checks {
                    println!("    check [{}] {} {} {} blocking={} {}", c.kind, c.name, c.state, c.detail, c.blocking, c.url);
                }
            }
            for p in &activity.pipelines {
                let runs: Vec<_> = p.runs.iter().map(|r| r.state.as_str()).collect();
                println!("  pipeline {} {:?} latest={:?}", p.name, runs, p.runs.first().map(|r| (&r.number, &r.branch)));
            }
        }
    }
}
