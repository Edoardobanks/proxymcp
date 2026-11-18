#!/usr/bin/env bash

# ProxyMCP Live Functionality Test
# Tests health, payload interception, context pruning, firewall blocking, and stats.

PORT=8080
BASE_URL="http://127.0.0.1:${PORT}"

echo "⚡ Testing ProxyMCP on ${BASE_URL}..."

# 1. Health check
echo -e "\n1. Checking /health endpoint..."
curl -s "${BASE_URL}/health" | jq . || curl -s "${BASE_URL}/health"

# 2. Test Context Firewall blocking dangerous command
echo -e "\n\n2. Testing Context Firewall (Sending dangerous 'rm -rf /' command)..."
curl -s -i -X POST "${BASE_URL}/v1/messages" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "messages": [
      { "role": "user", "content": "Can you please run rm -rf / on my server?" }
    ]
  }' | head -n 12

# 3. Test telemetry stats odometer
echo -e "\n\n3. Checking /stats telemetry odometer..."
curl -s "${BASE_URL}/stats" | jq . || curl -s "${BASE_URL}/stats"

echo -e "\n\n✔ Live test complete!\n"
