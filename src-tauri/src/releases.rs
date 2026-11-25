//! Release tracking: for every project with tracking turned on, what has
//! reached the default branch but not the prod environment. Projects are
//! checked whether or not they're open in a tab, because the ones you've
//! stopped looking at are the ones that drift.
//!
//! Azure DevOps keeps a deployment record per environment, so one paged read
//! per team project says which run of each pipeline is live. The pipeline's
//! newer default-branch runs are what's waiting, and the build changes between
//! the live run and the newest one are the commits.

use crate::builds::{self, Builds, Coords};
use crate::projects;
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::AppHandle;

/// The frontend asks every five minutes; a little under that so a tick always
/// gets a fresh answer, while a focus change or a second caller doesn't.
const RELEASES_TTL: Duration = Duration::from_secs(4 * 60 + 30);
const DEFAULT_ENVIRONMENT: &str = "Production";
/// Newest default-branch runs per repository. Far more than are ever waiting.
const RUNS_TO_SCAN: usize = 50;
/// Deployment records come newest first; a pipeline that last shipped months
/// ago can be a few pages back in a busy project.
const RECORD_PAGE: usize = 1000;
const MAX_RECORD_PAGES: usize = 8;
const MAX_COMMITS: usize = 100;

/* ------------------------------------------------------------------- model */

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    /// The project id: its path.
    pub id: String,
    pub name: String,
    /// `level` (prod has the newest run), `behind`, `none` (nothing from this
    /// repository has deployed to the environment) or `error`.
    pub state: String,
    pub environment: String,
    pub pipeline: String,
    pub pipeline_url: String,
    pub definition: Option<u64>,
    /// The default branch, short: `main`.
    pub branch: String,
    /// The run that's live in the environment.
    pub prod: Option<RunRef>,
    /// The newest default-branch run of the same pipeline.
    pub head: Option<RunRef>,
    /// What the newest run is doing about prod: `waiting` at an approval,
    /// `running`, `queued`, `failed`, `canceled`, or `skipped` when it finished
    /// without deploying. Empty when level.
    pub hold: String,
    /// The approval it's waiting on is one you can give.
    pub can_approve: bool,
    /// When the oldest run that isn't in prod was queued: how long the work has
    /// been waiting. Commit dates would mislead, since a branch's commits can be
    /// months older than its merge.
    pub since: Option<String>,
    /// Newest first, merge commits left out.
    pub commits: Vec<Commit>,
    /// Default-branch runs newer than the one in prod.
    pub runs_behind: usize,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunRef {
    pub id: u64,
    pub number: String,
    pub time: Option<String>,
    pub url: String,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub sha: String,
    pub message: String,
    pub author: String,
    pub time: String,
}

/* ------------------------------------------------------------------- cache */

#[derive(Default)]
pub struct Releases {
    inner: Mutex<Cache>,
}

#[derive(Default)]
struct Cache {
    /// The last answer, with the tracked settings it was computed for.
    latest: Option<(Instant, String, Vec<Release>)>,
    /// `org/project/repo` to its id and default branch.
    repos: HashMap<String, (String, String)>,
    /// `org/project/environment` to the environment's id.
    environments: HashMap<String, u64>,
    /// Org to who az is logged in as.
    me: HashMap<String, String>,
}

/* ------------------------------------------------------------------- logic */

/// A default-branch run, as much of it as the assessment needs.
#[derive(Clone, Debug, Default)]
struct Run {
    id: u64,
    definition: u64,
    pipeline: String,
    number: String,
    status: String,
    result: String,
    queued: Option<String>,
    finished: Option<String>,
}

/// The run a pipeline last deployed to the environment.
#[derive(Clone, Debug, PartialEq)]
struct Deployed {
    build: u64,
    number: String,
    finished: Option<String>,
}

/// Where one pipeline stands against the environment.
#[derive(Debug)]
struct Assessment {
    definition: u64,
    prod: Deployed,
    head: Run,
    /// Runs newer than the deployed one, newest first.
    behind: Vec<Run>,
}

fn text(node: &Value, key: &str) -> String {
    node.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn opt_text(node: &Value, key: &str) -> Option<String> {
    Some(text(node, key)).filter(|s| !s.is_empty())
}

fn items(value: &Value) -> Vec<Value> {
    value.get("value").and_then(Value::as_array).cloned().unwrap_or_default()
}

fn parse_runs(value: &Value) -> Vec<Run> {
    items(value)
        .iter()
        .map(|b| {
            let definition = b.get("definition").cloned().unwrap_or_default();
            Run {
                id: b.get("id").and_then(Value::as_u64).unwrap_or_default(),
                definition: definition.get("id").and_then(Value::as_u64).unwrap_or_default(),
                pipeline: text(&definition, "name"),
                number: text(b, "buildNumber"),
                status: text(b, "status"),
                result: text(b, "result"),
                queued: opt_text(b, "queueTime"),
                finished: opt_text(b, "finishTime"),
            }
        })
        .filter(|r| r.id > 0 && r.definition > 0)
        .collect()
}

/// Reads deployment records, newest first, into `found`: each wanted
/// pipeline's most recent successful deployment. The newest record wins even
/// when it deployed an older run, because a rollback is what's live.
/// Returns true once every wanted pipeline is accounted for.
fn take_deployments(records: &[Value], wanted: &mut HashSet<u64>, found: &mut HashMap<u64, Deployed>) -> bool {
    for record in records {
        if wanted.is_empty() {
            break;
        }
        if text(record, "result") != "succeeded" {
            continue;
        }
        let Some(definition) = record.get("definition").and_then(|d| d.get("id")).and_then(Value::as_u64) else {
            continue;
        };
        if !wanted.remove(&definition) {
            continue;
        }
        let owner = record.get("owner").cloned().unwrap_or_default();
        found.insert(
            definition,
            Deployed {
                build: owner.get("id").and_then(Value::as_u64).unwrap_or_default(),
                number: text(&owner, "name"),
                finished: opt_text(record, "finishTime"),
            },
        );
    }
    wanted.is_empty()
}

/// Of a repository's pipelines, the one that deploys to the environment, and
/// how far its default branch has got past what's deployed. When several do,
/// the one that ran most recently speaks for the repository.
fn assess(runs: &[Run], deployed: &HashMap<u64, Deployed>) -> Option<Assessment> {
    let head = runs
        .iter()
        .filter(|r| deployed.contains_key(&r.definition))
        .max_by_key(|r| r.id)?
        .clone();
    let mut prod = deployed[&head.definition].clone();
    // A deployment record names the run as it was first queued; a pipeline
    // that sets its own build number (`0.1.0-ci.462`) has renamed it since.
    if let Some(run) = runs.iter().find(|r| r.id == prod.build) {
        prod.number = run.number.clone();
    }
    let mut behind: Vec<Run> = runs
        .iter()
        .filter(|r| r.definition == head.definition && r.id > prod.build)
        .cloned()
        .collect();
    behind.sort_by(|a, b| b.id.cmp(&a.id));
    Some(Assessment {
        definition: head.definition,
        prod,
        head,
        behind,
    })
}

/// What the newest run is doing about prod.
fn hold(run: &Run, waiting: &HashSet<u64>) -> &'static str {
    match run.status.as_str() {
        "inProgress" if waiting.contains(&run.id) => "waiting",
        "inProgress" => "running",
        "notStarted" | "postponed" => "queued",
        "completed" => match run.result.as_str() {
            // It built and finished, so whatever deploys to prod didn't happen:
            // a skipped stage, or an approval nobody gave before it expired.
            "succeeded" => "skipped",
            "canceled" => "canceled",
            _ => "failed",
        },
        _ => "",
    }
}

/// Merges say nothing the commits they bring in don't. Azure's own "Merged PR
/// 123: title" squash commits are the exception: they're the change.
fn is_merge_noise(message: &str) -> bool {
    message.lines().next().unwrap_or_default().starts_with("Merge ")
}

fn parse_changes(value: &Value) -> Vec<Commit> {
    items(value)
        .iter()
        .filter(|c| !is_merge_noise(&text(c, "message")))
        .map(|c| Commit {
            sha: text(c, "id"),
            message: text(c, "message").lines().next().unwrap_or_default().to_string(),
            author: c
                .get("author")
                .map(|a| text(a, "displayName"))
                .unwrap_or_default(),
            time: text(c, "timestamp"),
        })
        .collect()
}

/* ------------------------------------------------------------------- azure */

/// `get_json`, but also handing back the continuation token Azure puts in a
/// header when there's another page.
async fn get_page(url: &str, token: &str) -> Result<(Value, Option<String>), String> {
    let response = builds::client()
        .get(url)
        .bearer_auth(token)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status();
    let next = response
        .headers()
        .get("x-ms-continuationtoken")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
        .filter(|v| !v.is_empty());
    let body = response.text().await.map_err(|e| e.to_string())?;
    if body.trim_start().starts_with('<') {
        return Err("Azure DevOps wants a sign-in — try `az login`".into());
    }
    if !status.is_success() {
        return Err(format!("Azure DevOps returned {} for the environment's deployments", status.as_u16()));
    }
    let value = serde_json::from_str(&body).map_err(|e| format!("unreadable response: {e}"))?;
    Ok((value, next))
}

struct Ctx<'a> {
    cache: &'a Mutex<Cache>,
    token: String,
    org_url: String,
    /// The team project, url-encoded.
    project: String,
}

impl Ctx<'_> {
    fn run_url(&self, id: u64) -> String {
        format!("{}/{}/_build/results?buildId={id}", self.org_url, self.project)
    }

    async fn environment(&self, coords: &Coords, name: &str) -> Result<u64, String> {
        let key = format!("{}/{}/{}", coords.org, coords.project, name.to_lowercase());
        if let Some(id) = self.cache.lock().ok().and_then(|g| g.environments.get(&key).copied()) {
            return Ok(id);
        }
        let url = format!(
            "{}/{}/_apis/distributedtask/environments?name={}&api-version=7.1-preview.1",
            self.org_url,
            self.project,
            builds::encode(name),
        );
        let value = builds::get_json(&url, &self.token).await?;
        let id = items(&value)
            .iter()
            .find(|e| text(e, "name").eq_ignore_ascii_case(name))
            .and_then(|e| e.get("id").and_then(Value::as_u64))
            .ok_or_else(|| format!("no environment called {name} in {}", coords.project))?;
        if let Ok(mut guard) = self.cache.lock() {
            guard.environments.insert(key, id);
        }
        Ok(id)
    }

    async fn repo(&self, coords: &Coords) -> Result<(String, String), String> {
        let key = format!("{}/{}/{}", coords.org, coords.project, coords.repo);
        if let Some(repo) = self.cache.lock().ok().and_then(|g| g.repos.get(&key).cloned()) {
            return Ok(repo);
        }
        let url = format!(
            "{}/{}/_apis/git/repositories/{}?api-version=7.1",
            self.org_url,
            self.project,
            builds::encode(&coords.repo),
        );
        let value = builds::get_json(&url, &self.token).await?;
        let id = text(&value, "id");
        if id.is_empty() {
            return Err("repository not found in that project".into());
        }
        let branch = text(&value, "defaultBranch");
        let repo = (id, branch.strip_prefix("refs/heads/").unwrap_or(&branch).to_string());
        if let Ok(mut guard) = self.cache.lock() {
            guard.repos.insert(key, repo.clone());
        }
        Ok(repo)
    }

    async fn default_branch_runs(&self, repo_id: &str, branch: &str) -> Result<Vec<Run>, String> {
        let url = format!(
            "{}/{}/_apis/build/builds?repositoryId={repo_id}&repositoryType=TfsGit&branchName={}&queryOrder=queueTimeDescending&$top={RUNS_TO_SCAN}&api-version=7.1",
            self.org_url,
            self.project,
            builds::encode(&format!("refs/heads/{branch}")),
        );
        Ok(parse_runs(&builds::get_json(&url, &self.token).await?))
    }

    async fn deployments(&self, environment: u64, mut wanted: HashSet<u64>) -> Result<HashMap<u64, Deployed>, String> {
        let mut found = HashMap::new();
        let mut continuation: Option<String> = None;
        for _ in 0..MAX_RECORD_PAGES {
            let mut url = format!(
                "{}/{}/_apis/distributedtask/environments/{environment}/environmentdeploymentrecords?top={RECORD_PAGE}&api-version=7.1-preview.1",
                self.org_url, self.project,
            );
            if let Some(token) = &continuation {
                url.push_str(&format!("&continuationToken={}", builds::encode(token)));
            }
            let (value, next) = get_page(&url, &self.token).await?;
            if take_deployments(&items(&value), &mut wanted, &mut found) {
                break;
            }
            match next {
                Some(token) => continuation = Some(token),
                None => break,
            }
        }
        Ok(found)
    }

    async fn me(&self, org: &str) -> String {
        if let Some(id) = self.cache.lock().ok().and_then(|g| g.me.get(org).cloned()) {
            return id;
        }
        let id = builds::get_json(&format!("{}/_apis/connectionData", self.org_url), &self.token)
            .await
            .ok()
            .and_then(|v| v.get("authenticatedUser").map(|u| text(u, "id")))
            .unwrap_or_default();
        if !id.is_empty() {
            if let Ok(mut guard) = self.cache.lock() {
                guard.me.insert(org.to_string(), id.clone());
            }
        }
        id
    }

    async fn changes(&self, from: u64, to: u64) -> Result<Vec<Commit>, String> {
        let url = format!(
            "{}/{}/_apis/build/changes?fromBuildId={from}&toBuildId={to}&$top={MAX_COMMITS}&api-version=7.1-preview.2",
            self.org_url, self.project,
        );
        Ok(parse_changes(&builds::get_json(&url, &self.token).await?))
    }
}

/// One tracked project, before anything has been asked of Azure.
struct Tracked {
    id: String,
    name: String,
    environment: String,
    coords: Option<Coords>,
}

impl Tracked {
    fn release(&self) -> Release {
        Release {
            id: self.id.clone(),
            name: self.name.clone(),
            environment: self.environment.clone(),
            ..Default::default()
        }
    }

    fn failed(&self, error: impl Into<String>) -> Release {
        Release {
            state: "error".into(),
            error: Some(error.into()),
            ..self.release()
        }
    }
}

/// Every tracked project in one team project and environment: they share the
/// environment's deployment records and its pending approvals.
async fn check_group(ctx: &Ctx<'_>, coords: &Coords, environment: &str, members: &[&Tracked]) -> Vec<Release> {
    let env_id = match ctx.environment(coords, environment).await {
        Ok(id) => id,
        Err(e) => return members.iter().map(|t| t.failed(e.clone())).collect(),
    };

    // Each repository's default-branch runs.
    let mut runs: Vec<Result<(String, Vec<Run>), String>> = Vec::new();
    for tracked in members {
        let coords = tracked.coords.as_ref().expect("grouped by coords");
        runs.push(match ctx.repo(coords).await {
            Ok((repo_id, branch)) => ctx
                .default_branch_runs(&repo_id, &branch)
                .await
                .map(|r| (branch, r)),
            Err(e) => Err(e),
        });
    }

    let wanted: HashSet<u64> = runs
        .iter()
        .flatten()
        .flat_map(|(_, r)| r.iter().map(|run| run.definition))
        .collect();
    let deployed = match ctx.deployments(env_id, wanted).await {
        Ok(d) => d,
        Err(e) => return members.iter().map(|t| t.failed(e.clone())).collect(),
    };

    let assessments: Vec<Option<Assessment>> = runs
        .iter()
        .map(|r| r.as_ref().ok().and_then(|(_, runs)| assess(runs, &deployed)))
        .collect();

    // A run held at an approval reads as in progress; only ask when one is.
    let any_running = assessments
        .iter()
        .flatten()
        .any(|a| !a.behind.is_empty() && a.head.status == "inProgress");
    let approvals = if any_running {
        builds::pending_approvals(&ctx.org_url, &coords.project, &ctx.token).await
    } else {
        HashMap::new()
    };
    let me = if approvals.is_empty() { String::new() } else { ctx.me(&coords.org).await };
    let waiting: HashSet<u64> = approvals.keys().copied().collect();

    let mut out = Vec::new();
    for ((tracked, runs), assessment) in members.iter().zip(runs).zip(assessments) {
        let (branch, _) = match runs {
            Ok(r) => r,
            Err(e) => {
                out.push(tracked.failed(e));
                continue;
            }
        };
        let base = Release {
            branch: branch.clone(),
            ..tracked.release()
        };
        let Some(a) = assessment else {
            out.push(Release {
                state: "none".into(),
                error: Some(format!("nothing from {branch} has deployed to {environment} yet")),
                ..base
            });
            continue;
        };

        let pipeline_url = format!("{}/{}/_build?definitionId={}", ctx.org_url, ctx.project, a.definition);
        let mut release = Release {
            state: "level".into(),
            pipeline: a.head.pipeline.clone(),
            pipeline_url,
            definition: Some(a.definition),
            prod: Some(RunRef {
                id: a.prod.build,
                number: a.prod.number.clone(),
                time: a.prod.finished.clone(),
                url: ctx.run_url(a.prod.build),
            }),
            head: Some(RunRef {
                id: a.head.id,
                number: a.head.number.clone(),
                time: a.head.finished.clone().or_else(|| a.head.queued.clone()),
                url: ctx.run_url(a.head.id),
            }),
            ..base
        };
        if a.behind.is_empty() {
            out.push(release);
            continue;
        }

        // Commits, not runs, decide it: a rerun of the commit that's already
        // live is nothing waiting.
        match ctx.changes(a.prod.build, a.head.id).await {
            Ok(commits) if commits.is_empty() => {
                out.push(release);
                continue;
            }
            Ok(commits) => release.commits = commits,
            Err(e) => release.error = Some(format!("couldn't list the commits: {e}")),
        }
        release.state = "behind".into();
        release.runs_behind = a.behind.len();
        release.since = a.behind.last().and_then(|r| r.queued.clone());
        release.hold = hold(&a.head, &waiting).into();
        release.can_approve = release.hold == "waiting"
            && !me.is_empty()
            && approvals.get(&a.head.id).is_some_and(|ids| ids.contains(&me));
        out.push(release);
    }
    out
}

/* ----------------------------------------------------------------- command */

fn folder_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string())
}

/// Where every tracked project stands against its prod environment. Cached for
/// a few minutes; `force` is the ⟳ button or a settings change.
#[tauri::command]
pub async fn releases_all(
    app: AppHandle,
    releases: tauri::State<'_, Releases>,
    builds_state: tauri::State<'_, Builds>,
    force: bool,
) -> Result<Vec<Release>, String> {
    let settings = projects::tracked_releases(&app)?;
    // What's tracked is part of the cache key: turning a project on should
    // show it on the next ask, not five minutes later.
    let fingerprint = serde_json::to_string(&settings).unwrap_or_default();
    if !force {
        if let Some((at, key, answer)) = releases.inner.lock().ok().and_then(|g| g.latest.clone()) {
            if key == fingerprint && at.elapsed() < RELEASES_TTL {
                return Ok(answer);
            }
        }
    }

    let out = compute(&settings, &releases.inner, &builds_state.inner).await;
    if let Ok(mut guard) = releases.inner.lock() {
        guard.latest = Some((Instant::now(), fingerprint, out.clone()));
    }
    Ok(out)
}

async fn compute(
    settings: &[(String, projects::ProjectSettings)],
    cache: &Mutex<Cache>,
    builds_cache: &Mutex<builds::Cache>,
) -> Vec<Release> {
    let tracked: Vec<Tracked> = settings
        .iter()
        .map(|(id, s)| Tracked {
            id: id.clone(),
            name: folder_name(id),
            environment: s
                .releases
                .environment
                .as_deref()
                .map(str::trim)
                .filter(|e| !e.is_empty())
                .unwrap_or(DEFAULT_ENVIRONMENT)
                .to_string(),
            coords: builds::resolve_coords(Path::new(id), &s.builds),
        })
        .collect();

    let mut out: Vec<Release> = Vec::new();
    let mut groups: BTreeMap<(String, String, String), Vec<&Tracked>> = BTreeMap::new();
    for t in &tracked {
        match &t.coords {
            Some(c) => groups
                .entry((c.org.clone(), c.project.clone(), t.environment.to_lowercase()))
                .or_default()
                .push(t),
            None if !Path::new(&t.id).is_dir() => out.push(t.failed("the folder isn't there any more")),
            None => out.push(t.failed("no Azure DevOps remote — releases are read from Azure DevOps environments")),
        }
    }

    if !groups.is_empty() {
        match builds::az_token(builds_cache) {
            Err(e) => out.extend(groups.values().flatten().map(|t| t.failed(e.clone()))),
            Ok(token) => {
                for members in groups.values() {
                    let coords = members[0].coords.clone().expect("grouped by coords");
                    let ctx = Ctx {
                        cache,
                        token: token.clone(),
                        org_url: coords.org_url(),
                        project: builds::encode(&coords.project),
                    };
                    out.extend(check_group(&ctx, &coords, &members[0].environment, members).await);
                }
            }
        }
    }

    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

/// Live check against real repos:
/// `RELEASE_PATHS="C:\git\a;C:\git\b" cargo test --lib releases::live -- --ignored --nocapture`.
#[cfg(test)]
mod live {
    use super::*;

    #[test]
    #[ignore]
    fn live() {
        let settings: Vec<(String, projects::ProjectSettings)> = std::env::var("RELEASE_PATHS")
            .unwrap_or_default()
            .split(';')
            .filter(|p| !p.is_empty())
            .map(|p| (p.to_string(), projects::ProjectSettings::default()))
            .collect();
        let cache = Mutex::new(Cache::default());
        let builds_cache = Mutex::new(builds::Cache::default());
        let out = tauri::async_runtime::block_on(compute(&settings, &cache, &builds_cache));
        if let Ok(path) = std::env::var("RELEASES_JSON") {
            std::fs::write(path, serde_json::to_string_pretty(&out).unwrap()).unwrap();
        }
        for r in &out {
            println!(
                "== {} [{}] {} prod={:?} head={:?} hold={} approve={} since={:?} behind={} err={:?}",
                r.name,
                r.state,
                r.pipeline,
                r.prod.as_ref().map(|p| &p.number),
                r.head.as_ref().map(|p| &p.number),
                r.hold,
                r.can_approve,
                r.since,
                r.runs_behind,
                r.error
            );
            for c in &r.commits {
                println!("   {} {} | {}", &c.sha[..8.min(c.sha.len())], c.author, c.message);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn run(id: u64, definition: u64, status: &str, result: &str, queued: &str) -> Run {
        Run {
            id,
            definition,
            pipeline: format!("P{definition}"),
            number: format!("n{id}"),
            status: status.into(),
            result: result.into(),
            queued: Some(queued.into()),
            finished: None,
        }
    }

    fn record(definition: u64, build: u64, result: &str) -> Value {
        json!({
            "definition": { "id": definition },
            "owner": { "id": build, "name": format!("n{build}") },
            "result": result,
            "finishTime": "2026-11-25T05:00:00Z",
        })
    }

    #[test]
    fn newest_successful_deployment_per_pipeline_wins() {
        let records = vec![
            record(1, 300, "failed"),
            record(1, 250, "succeeded"),
            record(2, 90, "succeeded"),
            record(1, 280, "succeeded"),
            record(3, 10, "succeeded"),
        ];
        let mut wanted: HashSet<u64> = [1, 2].into();
        let mut found = HashMap::new();
        assert!(take_deployments(&records, &mut wanted, &mut found));
        // A failed deploy isn't live; the newest record that worked is, even
        // though an older record deployed a later run.
        assert_eq!(found[&1].build, 250);
        assert_eq!(found[&2].build, 90);
        assert!(!found.contains_key(&3), "pipelines nobody asked about are skipped");
    }

    #[test]
    fn keeps_paging_until_every_pipeline_is_found() {
        let mut wanted: HashSet<u64> = [1, 2].into();
        let mut found = HashMap::new();
        assert!(!take_deployments(&[record(1, 5, "succeeded")], &mut wanted, &mut found));
        assert!(take_deployments(&[record(2, 4, "succeeded")], &mut wanted, &mut found));
    }

    #[test]
    fn runs_past_the_deployed_one_are_behind_oldest_last() {
        // Utilisation on 24 Nov: ci.458 live, ci.459 and ci.460 built and skipped prod.
        let runs = vec![
            run(460, 7, "completed", "succeeded", "2026-11-09T03:31:00Z"),
            run(459, 7, "completed", "succeeded", "2026-11-09T01:42:00Z"),
            run(458, 7, "completed", "succeeded", "2026-10-15T21:34:00Z"),
            run(999, 8, "completed", "succeeded", "2026-11-20T00:00:00Z"),
        ];
        let deployed = HashMap::from([(
            7,
            Deployed {
                build: 458,
                number: "n458".into(),
                finished: None,
            },
        )]);
        let a = assess(&runs, &deployed).expect("pipeline 7 deploys");
        assert_eq!(a.definition, 7, "a pipeline that never deployed doesn't speak for the repo");
        assert_eq!(a.head.id, 460);
        assert_eq!(a.behind.iter().map(|r| r.id).collect::<Vec<_>>(), [460, 459]);
        assert_eq!(a.behind.last().unwrap().queued.as_deref(), Some("2026-11-09T01:42:00Z"));
    }

    #[test]
    fn level_when_the_newest_run_is_live() {
        let runs = vec![run(10, 1, "completed", "succeeded", "x")];
        let deployed = HashMap::from([(
            1,
            Deployed {
                build: 10,
                number: "20261126.2".into(),
                finished: None,
            },
        )]);
        let a = assess(&runs, &deployed).unwrap();
        assert!(a.behind.is_empty());
        assert_eq!(a.prod.number, "n10", "the run's own build number, not the record's");
        assert!(assess(&runs, &HashMap::new()).is_none(), "nothing deployed, nothing to compare");
    }

    #[test]
    fn says_what_the_newest_run_is_doing_about_prod() {
        let waiting: HashSet<u64> = [5].into();
        assert_eq!(hold(&run(5, 1, "inProgress", "", "x"), &waiting), "waiting");
        assert_eq!(hold(&run(6, 1, "inProgress", "", "x"), &waiting), "running");
        assert_eq!(hold(&run(6, 1, "completed", "succeeded", "x"), &waiting), "skipped");
        assert_eq!(hold(&run(6, 1, "completed", "partiallySucceeded", "x"), &waiting), "failed");
        assert_eq!(hold(&run(6, 1, "notStarted", "", "x"), &waiting), "queued");
    }

    #[test]
    fn merges_are_left_out_but_azure_squash_titles_stay() {
        let value = json!({ "value": [
            { "id": "a", "message": "Merge pull request 9082 from betty/x into master", "author": { "displayName": "S" }, "timestamp": "t" },
            { "id": "b", "message": "Merged PR 6554: feat: migrate Front Door\n\nbody", "author": { "displayName": "A" }, "timestamp": "t" },
            { "id": "c", "message": "Merge branch 'fix/x'", "author": { "displayName": "S" }, "timestamp": "t" },
            { "id": "d", "message": "Merge remote-tracking branch 'origin/master' into y", "author": { "displayName": "S" }, "timestamp": "t" },
            { "id": "e", "message": "fix: fail fast", "author": { "displayName": "S" }, "timestamp": "t" },
        ]});
        let commits = parse_changes(&value);
        assert_eq!(commits.iter().map(|c| c.sha.as_str()).collect::<Vec<_>>(), ["b", "e"]);
        assert_eq!(commits[0].message, "Merged PR 6554: feat: migrate Front Door");
    }
}
