# Web Search Skill

## Brave Search (web search)
```bash
curl -sf "https://api.search.brave.com/res/v1/web/search?q=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$QUERY")&count=5" \
  -H "Accept: application/json" \
  -H "X-Subscription-Token: $BRAVE_API_KEY" | jq '.web.results[] | {title, url, description}'
```

## Read a web page
```bash
curl -sL "$URL" | python3 -c "
import sys, re
html = sys.stdin.read()
# Strip tags
text = re.sub(r'<[^>]+>', ' ', html)
text = re.sub(r'\s+', ' ', text).strip()
print(text[:5000])
"
```

## GitLab search
```bash
# Search code
glab api "projects/:id/search?scope=blobs&search=$QUERY" --hostname "$GITLAB_HOST"

# List MRs
glab mr list --repo "$GITLAB_REPO"

# Create issue
glab issue create --title "$TITLE" --description "$DESC" --repo "$GITLAB_REPO"
```
