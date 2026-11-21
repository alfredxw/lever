package github

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"lever/internal/device"
	"lever/internal/model"
	"lever/internal/plugin"
)

const (
	PluginID       = "lever.github"
	ContributionID = "github"
	githubAPI      = "https://api.github.com"
)

var githubRepoName = regexp.MustCompile(`^[a-zA-Z0-9-]{1,100}/[a-zA-Z0-9_.-]{1,100}$`)

type githubTaskSource struct {
	client *http.Client
}

func NewTaskSource() plugin.TaskSourceAdapter {
	return githubTaskSource{client: githubHTTPClient()}
}

type githubRepository struct {
	ID   int64  `json:"id"`
	Name string `json:"full_name"`
}

type githubIssue struct {
	ID        string    `json:"node_id"`
	Number    int       `json:"number"`
	UpdatedAt time.Time `json:"updated_at"`
	State     string    `json:"state"`
	Title     string    `json:"title"`
	Body      string    `json:"body"`
	Pull      *struct {
		MergedAt *time.Time `json:"merged_at"`
	} `json:"pull_request"`
}

func githubHTTPClient() *http.Client {
	return &http.Client{
		Timeout: 20 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 || !githubAPIURL(req.URL) {
				return http.ErrUseLastResponse
			}
			return nil
		},
	}
}

func githubAPIURL(u *url.URL) bool {
	return u.Scheme == "https" && u.Host == "api.github.com" && u.User == nil
}

func githubToken(ctx context.Context) string {
	for _, key := range []string{"GH_TOKEN", "GITHUB_TOKEN"} {
		if token := strings.TrimSpace(os.Getenv(key)); token != "" {
			return token
		}
	}
	// Desktop launches may have a reduced PATH. Prefer an explicit PATH entry
	// and use the same fallback locations as the other local tools.
	path, err := exec.LookPath("gh")
	if err != nil {
		path, err = device.Executable("gh")
		if err != nil {
			return ""
		}
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, path, "auth", "token", "--hostname", "github.com")
	command.Env = append(device.Environment(), "GH_PROMPT_DISABLED=1")
	out, err := command.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

func (g githubTaskSource) get(ctx context.Context, token, endpoint string, into any) (string, time.Time, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil || !githubAPIURL(req.URL) {
		return "", time.Time{}, githubResponseError()
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	response, err := g.client.Do(req)
	if err != nil {
		return "", time.Time{}, &plugin.TaskSourceError{Status: 502, Code: "offline", Message: "Could not connect to GitHub"}
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", time.Time{}, githubStatusError(response)
	}
	decoder := json.NewDecoder(http.MaxBytesReader(nil, response.Body, 48<<20))
	if err := decoder.Decode(into); err != nil {
		return "", time.Time{}, githubResponseError()
	}
	if !errors.Is(decoder.Decode(new(any)), io.EOF) {
		return "", time.Time{}, githubResponseError()
	}
	date, _ := http.ParseTime(response.Header.Get("Date"))
	for _, link := range strings.Split(response.Header.Get("Link"), ",") {
		target, rel, _ := strings.Cut(strings.TrimSpace(link), ";")
		if strings.TrimSpace(rel) == `rel="next"` {
			return strings.Trim(target, "<>"), date, nil
		}
	}
	return "", date, nil
}

func githubResponseError() error {
	return &plugin.TaskSourceError{Status: 502, Code: "response", Message: "GitHub returned an invalid response"}
}

func githubStatusError(response *http.Response) error {
	switch response.StatusCode {
	case http.StatusTooManyRequests, http.StatusForbidden:
		retry := response.Header.Get("Retry-After")
		limited := response.StatusCode == http.StatusTooManyRequests || retry != "" || response.Header.Get("X-RateLimit-Remaining") == "0"
		if !limited {
			// Secondary limits can also return 403 with remaining quota.
			body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
			limited = strings.Contains(strings.ToLower(string(body)), "rate limit")
		}
		if limited {
			waitUntil, _ := http.ParseTime(retry)
			if seconds, err := strconv.Atoi(retry); err == nil {
				waitUntil = time.Now().Add(time.Duration(seconds) * time.Second)
			}
			if response.Header.Get("X-RateLimit-Remaining") == "0" {
				if seconds, err := strconv.ParseInt(response.Header.Get("X-RateLimit-Reset"), 10, 64); err == nil && time.Unix(seconds, 0).After(waitUntil) {
					waitUntil = time.Unix(seconds, 0)
				}
			}
			return &plugin.TaskSourceError{Status: 429, Code: "rateLimit", Message: "GitHub rate limited this source. Try again later.", RetryAt: waitUntil}
		}
		fallthrough
	case http.StatusUnauthorized, http.StatusNotFound, http.StatusGone, http.StatusUnavailableForLegalReasons:
		return &plugin.TaskSourceError{Status: response.StatusCode, Code: "access", Message: "GitHub denied access. Check the repository name and your GitHub CLI sign-in."}
	default:
		return &plugin.TaskSourceError{Status: 502, Code: "response", Message: "GitHub could not return the requested data"}
	}
}

func validGitHubRepository(name string) bool {
	_, repo, _ := strings.Cut(name, "/")
	return githubRepoName.MatchString(name) && repo != "." && repo != ".."
}

func (g githubTaskSource) repository(ctx context.Context, token, path string) (githubRepository, time.Time, error) {
	var repo githubRepository
	_, date, err := g.get(ctx, token, githubAPI+path, &repo)
	if err == nil && (repo.ID <= 0 || !validGitHubRepository(repo.Name)) {
		err = githubResponseError()
	}
	return repo, date, err
}

func (g githubTaskSource) Resolve(ctx context.Context, config string) (plugin.TaskSourceTarget, error) {
	name := strings.TrimSpace(config)
	if link, err := url.Parse(name); err == nil && link.Scheme == "https" && strings.EqualFold(link.Host, "github.com") && link.User == nil && link.RawQuery == "" && link.Fragment == "" {
		name = strings.Trim(link.Path, "/")
	}
	if !validGitHubRepository(name) {
		return plugin.TaskSourceTarget{}, &plugin.TaskSourceError{Status: 400, Code: "repository", Message: "Enter a GitHub repository as owner/repo"}
	}
	repo, _, err := g.repository(ctx, githubToken(ctx), "/repos/"+name)
	return plugin.TaskSourceTarget{ID: strconv.FormatInt(repo.ID, 10), Name: repo.Name}, err
}

func (g githubTaskSource) issues(ctx context.Context, token, path, state string, since time.Time) ([]githubIssue, error) {
	query := url.Values{"per_page": {"100"}, "state": {state}}
	if since.IsZero() {
		// A fixed creation order reduces page shifts during the open snapshot.
		query.Set("sort", "created")
	} else {
		query.Set("sort", "updated")
		query.Set("since", since.Format(time.RFC3339))
	}
	query.Set("direction", "asc")
	endpoint := githubAPI + path + "/issues?" + query.Encode()
	var issues []githubIssue
	for endpoint != "" {
		// GitHub often returns the next page under a mutable owner/repo path.
		// Keep the repository ID and take only the server's pagination query.
		link, err := url.Parse(endpoint)
		if err != nil || !githubAPIURL(link) || link.RawQuery == "" {
			return nil, githubResponseError()
		}
		var page []githubIssue
		next, _, err := g.get(ctx, token, githubAPI+path+"/issues?"+link.RawQuery, &page)
		if err != nil {
			return nil, err
		}
		if page == nil || next == endpoint {
			return nil, githubResponseError()
		}
		issues = append(issues, page...)
		endpoint = next
	}
	return issues, nil
}

func (issue githubIssue) kind() model.TaskSourceKind {
	if issue.Pull != nil {
		return model.TaskSourceKindPR
	}
	return model.TaskSourceKindIssue
}

func (issue githubIssue) task(repo string) (plugin.TaskSourceItem, error) {
	if issue.ID == "" || issue.Number <= 0 || strings.TrimSpace(issue.Title) == "" || issue.UpdatedAt.IsZero() ||
		(issue.State != "open" && issue.State != "closed") {
		return plugin.TaskSourceItem{}, githubResponseError()
	}
	number := strconv.Itoa(issue.Number)
	kind, path, state := issue.kind(), "/issues/", issue.State
	if kind == model.TaskSourceKindPR {
		path = "/pull/"
		if issue.Pull.MergedAt != nil {
			state = "merged"
		}
	}
	return plugin.TaskSourceItem{
		TaskSourceRef: plugin.TaskSourceRef{ExternalID: issue.ID, Reference: "#" + number},
		Kind:          string(kind), State: state, Title: issue.Title, Body: issue.Body,
		URL: "https://github.com/" + repo + path + number,
	}, nil
}

func (g githubTaskSource) Pull(ctx context.Context, target plugin.TaskSourceTarget, cursor string, open []plugin.TaskSourceRef) (plugin.TaskSourceBatch, error) {
	var since time.Time
	var err error
	// A timestamp on its own is a checkpoint for both kinds.
	stamp, previousKind, singleKind := strings.Cut(cursor, " ")
	if cursor != "" {
		since, err = time.Parse(time.RFC3339, stamp)
		if err != nil {
			return plugin.TaskSourceBatch{}, err
		}
	}
	token := githubToken(ctx)
	path := "/repositories/" + target.ID
	repo, started, err := g.repository(ctx, token, path)
	if err != nil {
		return plugin.TaskSourceBatch{}, err
	}
	if started.IsZero() || strconv.FormatInt(repo.ID, 10) != target.ID {
		return plugin.TaskSourceBatch{}, githubResponseError()
	}
	latest := make(map[string]githubIssue)
	collect := func(state string, from time.Time) error {
		issues, err := g.issues(ctx, token, path, state, from)
		if err != nil {
			return err
		}
		for _, issue := range issues {
			if target.SyncKind != model.TaskSourceKindBoth && target.SyncKind != issue.kind() {
				continue
			}
			if !issue.UpdatedAt.Before(latest[issue.ID].UpdatedAt) {
				latest[issue.ID] = issue
			}
		}
		return nil
	}
	// Refresh open items after adding a kind, while retaining the incremental
	// window for items that were already being tracked.
	addedKind := singleKind && previousKind != string(target.SyncKind)
	reconcile := cursor != "" && (addedKind || repo.Name != target.Name ||
		started.Truncate(24*time.Hour).After(since.Truncate(24*time.Hour)))
	if cursor == "" || reconcile {
		if err := collect("open", time.Time{}); err != nil {
			return plugin.TaskSourceBatch{}, err
		}
	}
	if since.IsZero() || started.Before(since) {
		since = started
	}
	// Overlap the start of the last successful pull. The API filters by
	// updated_at, and items changed during this pull can move between pages.
	if err := collect("all", since.Add(-time.Minute)); err != nil {
		return plugin.TaskSourceBatch{}, err
	}
	batch := plugin.TaskSourceBatch{Name: repo.Name, Cursor: started.Format(time.RFC3339)}
	if target.SyncKind != model.TaskSourceKindBoth {
		batch.Cursor += " " + string(target.SyncKind)
	}
	ordered := make([]githubIssue, 0, len(latest))
	for _, issue := range latest {
		ordered = append(ordered, issue)
	}
	slices.SortFunc(ordered, func(a, b githubIssue) int { return a.Number - b.Number })
	for _, issue := range ordered {
		item, err := issue.task(repo.Name)
		if err != nil {
			return plugin.TaskSourceBatch{}, err
		}
		// The first pull starts with open work and includes changes that landed
		// while the open pages were being fetched.
		batch.Items = append(batch.Items, item)
	}
	if reconcile {
		for _, ref := range open {
			if _, found := latest[ref.ExternalID]; found {
				continue
			}
			var issue githubIssue
			_, _, err := g.get(ctx, token, githubAPI+path+"/issues/"+strings.TrimPrefix(ref.Reference, "#"), &issue)
			var failure *plugin.TaskSourceError
			if (errors.As(err, &failure) && (failure.Status == 404 || failure.Status == 410)) ||
				(err == nil && (issue.ID != ref.ExternalID || "#"+strconv.Itoa(issue.Number) != ref.Reference)) {
				batch.Items = append(batch.Items, plugin.TaskSourceItem{TaskSourceRef: ref, State: "unavailable"})
				continue
			}
			if err != nil {
				return plugin.TaskSourceBatch{}, err
			}
			item, err := issue.task(repo.Name)
			if err != nil {
				return plugin.TaskSourceBatch{}, err
			}
			batch.Items = append(batch.Items, item)
		}
	}
	return batch, nil
}
