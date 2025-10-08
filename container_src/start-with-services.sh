#!/bin/bash
set -euo pipefail

# Create status directory and set permissions
sudo mkdir -p /status
sudo chown 1000:1000 /status
sudo chmod 755 /status

# Helper function to write startup status
write_status() {
  echo "$1" | sudo tee /status/step.txt > /dev/null
  sudo chown 1000:1000 /status/step.txt
  sudo chmod 644 /status/step.txt
  echo "[Status] $1"
}

do_optional_plugins() {
  # Temporarily disable exit-on-error for this function
  set +e
  
  if [ -n "${OPTIONAL_PLUGINS:-}" ]; then
    # Handle the case where OPTIONAL_PLUGINS is an empty string
    for plugin in $OPTIONAL_PLUGINS; do
      # Skip empty plugin names (can happen if OPTIONAL_PLUGINS is just "")
      if [ -z "$plugin" ]; then
        continue
      fi
      src="/data/optional_plugins/${plugin}.jar"
      dest="/data/plugins/${plugin}.jar"
      
      # Wrap operations in error handling
      if [ -f "$src" ]; then
        # Only create the symlink if it doesn't already exist or points elsewhere
        if [ ! -L "$dest" ] || [ "$(readlink "$dest")" != "$src" ]; then
          if ln -sf "$src" "$dest" 2>/dev/null; then
            echo "Optional plugin $plugin linked successfully"
          else
            echo "Warning: Failed to link optional plugin $plugin: $src -> $dest (continuing anyway)"
          fi
        else
          echo "Optional plugin $plugin already linked"
        fi
      else
        echo "Warning: Optional plugin $src not found, skipping."
      fi
    done
  fi
  
  # Re-enable exit-on-error
  set -e
}

start_tailscale() {

  if ! command -v tailscaled >/dev/null 2>&1; then
    return
  fi

  TAILSCALE_SOCKET="${TAILSCALE_SOCKET:-/run/tailscale/tailscaled.sock}"
  TAILSCALE_STATE_DIR="${TAILSCALE_STATE_DIR:-/var/lib/tailscale/tailscaled.state}"

  # Support both TAILSCALE_AUTHKEY and TS_AUTHKEY (from worker)
  AUTHKEY="${TS_AUTHKEY:-${TAILSCALE_AUTHKEY:-}}"
  
  # Skip Tailscale if no authkey is provided
  if [ -z "${AUTHKEY}" ]; then
    echo "Skipping Tailscale (no TS_AUTHKEY found)"
    return
  fi
  
  # Use TS_EXTRA_ARGS if available, fallback to TAILSCALE_ARGS
  EXTRA_ARGS="${TS_EXTRA_ARGS:-${TAILSCALE_ARGS:-}}"

  if ! pgrep -x tailscaled >/dev/null 2>&1; then
    # Add health check configuration if enabled
    TAILSCALED_ARGS="--state=${TAILSCALE_STATE_DIR} --socket=${TAILSCALE_SOCKET} --port=${TAILSCALE_PORT:-41641}"
    
    if [ "${TS_ENABLE_HEALTH_CHECK:-false}" = "true" ] && [ -n "${TS_LOCAL_ADDR_PORT:-}" ]; then
      TAILSCALED_ARGS="${TAILSCALED_ARGS} --debug=${TS_LOCAL_ADDR_PORT}"
    fi
    
    # Run in userspace mode for container compatibility
    TAILSCALED_ARGS="${TAILSCALED_ARGS} --tun=userspace-networking"
    
    sudo /usr/sbin/tailscaled ${TAILSCALED_ARGS} &
  fi

  if [ -n "${AUTHKEY}" ]; then
    # Wait for tailscaled to be ready before running tailscale up
    for i in $(seq 1 20); do
      if sudo tailscale --socket="${TAILSCALE_SOCKET}" status >/dev/null 2>&1; then
        break
      fi
      sleep 0.5
    done

    echo "Connecting to Tailscale network..."
    sudo tailscale --socket="${TAILSCALE_SOCKET}" up \
      --authkey="${AUTHKEY}" \
      --accept-routes=false \
      --accept-dns=false \
      --netfilter-mode=off \
      ${TAILSCALE_HOSTNAME:+--hostname="${TAILSCALE_HOSTNAME}"} \
      ${EXTRA_ARGS}
    
    if [ $? -eq 0 ]; then
      echo "Tailscale connected successfully"
    else
      echo "Warning: Tailscale connection failed, continuing anyway..."
    fi
  fi
}

configure_dynmap() {
  if [ -z "${AWS_ACCESS_KEY_ID:-}" ] || [ -z "${DYNMAP_BUCKET:-}" ]; then
    echo "Skipping Dynmap S3 configuration (no R2 credentials found)"
    return
  fi

  echo "Configuring Dynmap for S3 storage..."
  mkdir -p /data/plugins/dynmap

  # Copy the template configuration and substitute placeholders
  sed -e "s|{{AWS_ENDPOINT_URL}}|${AWS_ENDPOINT_URL}|g" \
      -e "s|{{DYNMAP_BUCKET}}|${DYNMAP_BUCKET}|g" \
      -e "s|{{AWS_ACCESS_KEY_ID}}|${AWS_ACCESS_KEY_ID}|g" \
      -e "s|{{AWS_SECRET_ACCESS_KEY}}|${AWS_SECRET_ACCESS_KEY}|g" \
      /dynmap-configuration.txt > /data/plugins/dynmap/configuration.txt

  echo "Dynmap S3 configuration complete"
  cat /data/plugins/dynmap/configuration.txt
}


start_http_proxy() {
  echo "Starting HTTP proxy server..."
  
  # Detect architecture
  ARCH=$(uname -m)
  echo "Detected architecture: $ARCH"
  
  # Determine the order to try binaries based on architecture
  if [ "$ARCH" = "x86_64" ] || [ "$ARCH" = "amd64" ]; then
    # x86_64 system - try x64 first, then arm64
    BINARIES=("/usr/local/bin/http-proxy-x64" "/usr/local/bin/http-proxy-arm64")
    NAMES=("x64" "arm64")
  elif [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
    # ARM64 system - try arm64 first, then x64
    BINARIES=("/usr/local/bin/http-proxy-arm64" "/usr/local/bin/http-proxy-x64")
    NAMES=("arm64" "x64")
  else
    # Unknown architecture - try both starting with x64
    echo "Warning: Unknown architecture $ARCH"
    BINARIES=("/usr/local/bin/http-proxy-x64" "/usr/local/bin/http-proxy-arm64")
    NAMES=("x64" "arm64")
  fi
  
  PROXY_BINARY=""
  
  # Try each binary in order
  for i in 0 1; do
    BINARY="${BINARIES[$i]}"
    NAME="${NAMES[$i]}"
    
    if [ ! -x "$BINARY" ]; then
      echo "Binary $NAME not found or not executable"
      continue
    fi
    
    echo "Testing $NAME binary..."
    
    # Try to execute and check for errors
    # Exit codes: 126 = cannot execute, 133 = Rosetta/emulation failure
    if timeout 2 "$BINARY" --help >/dev/null 2>&1; then
      echo "✓ $NAME binary is compatible"
      PROXY_BINARY="$BINARY"
      break
    else
      EXIT_CODE=$?
      if [ $EXIT_CODE -eq 126 ] || [ $EXIT_CODE -eq 133 ]; then
        echo "✗ $NAME binary: Architecture mismatch (exit code $EXIT_CODE)"
      elif [ $EXIT_CODE -eq 124 ]; then
        echo "✓ $NAME binary timed out but seems to work (this is OK)"
        PROXY_BINARY="$BINARY"
        break
      else
        echo "✗ $NAME binary failed with exit code $EXIT_CODE"
      fi
    fi
  done
  
  if [ -z "$PROXY_BINARY" ]; then
    echo "Warning: No compatible HTTP proxy binary found, skipping..."
    return
  fi
  
  echo "Using proxy binary: $PROXY_BINARY"
  
  # Run the HTTP proxy server in background
  (
    while true; do
      echo "Starting HTTP proxy (attempt at $(date))"
      $PROXY_BINARY || echo "HTTP proxy crashed (exit code: $?), restarting in 2 seconds..."
      sleep 2
    done
  ) &
  HTTP_PROXY_PID=$!
  
  echo "HTTP proxy server started in background (PID: $HTTP_PROXY_PID)"
}

setup_hteetp() {
  echo "Setting up hteetp binary..."
  
  # Detect architecture
  ARCH=$(uname -m)
  echo "Detected architecture: $ARCH"
  
  # Determine the order to try binaries based on architecture
  if [ "$ARCH" = "x86_64" ] || [ "$ARCH" = "amd64" ]; then
    # x86_64 system - try x64 first, then arm64
    BINARIES=("/usr/local/bin/hteetp-linux-x64" "/usr/local/bin/hteetp-linux-arm64")
    NAMES=("x64" "arm64")
  elif [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
    # ARM64 system - try arm64 first, then x64
    BINARIES=("/usr/local/bin/hteetp-linux-arm64" "/usr/local/bin/hteetp-linux-x64")
    NAMES=("arm64" "x64")
  else
    # Unknown architecture - try both starting with x64
    echo "Warning: Unknown architecture $ARCH"
    BINARIES=("/usr/local/bin/hteetp-linux-x64" "/usr/local/bin/hteetp-linux-arm64")
    NAMES=("x64" "arm64")
  fi
  
  HTEETP_BINARY=""
  
  # Try each binary in order
  for i in 0 1; do
    BINARY="${BINARIES[$i]}"
    NAME="${NAMES[$i]}"
    
    if [ ! -x "$BINARY" ]; then
      echo "Binary $NAME not found or not executable"
      continue
    fi
    
    echo "Testing $NAME binary..."
    
    # Try to execute and check for errors
    # Exit codes: 126 = cannot execute, 133 = Rosetta/emulation failure
    if timeout 2 "$BINARY" --help >/dev/null 2>&1; then
      echo "✓ $NAME binary is compatible"
      HTEETP_BINARY="$BINARY"
      break
    else
      EXIT_CODE=$?
      if [ $EXIT_CODE -eq 126 ] || [ $EXIT_CODE -eq 133 ]; then
        echo "✗ $NAME binary: Architecture mismatch (exit code $EXIT_CODE)"
      elif [ $EXIT_CODE -eq 124 ]; then
        echo "✓ $NAME binary timed out but seems to work (this is OK)"
        HTEETP_BINARY="$BINARY"
        break
      else
        echo "✗ $NAME binary failed with exit code $EXIT_CODE"
      fi
    fi
  done
  
  if [ -z "$HTEETP_BINARY" ]; then
    echo "Error: No compatible hteetp binary found!"
    return 1
  fi
  
  echo "Using hteetp binary: $HTEETP_BINARY"
  
  # Create symlink in /tmp (writable by user 1000)
  sudo ln -sf "$HTEETP_BINARY" /usr/local/bin/hteetp
  
  echo "hteetp symlink created successfully"
}

start_file_server() {
  echo "Starting file server on port 8083..."
  
  # Detect architecture
  ARCH=$(uname -m)
  echo "Detected architecture: $ARCH"
  
  # Determine the order to try binaries based on architecture
  if [ "$ARCH" = "x86_64" ] || [ "$ARCH" = "amd64" ]; then
    # x86_64 system - try x64 first, then arm64
    BINARIES=("/usr/local/bin/file-server-x64" "/usr/local/bin/file-server-arm64")
    NAMES=("x64" "arm64")
  elif [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
    # ARM64 system - try arm64 first, then x64
    BINARIES=("/usr/local/bin/file-server-arm64" "/usr/local/bin/file-server-x64")
    NAMES=("arm64" "x64")
  else
    # Unknown architecture - try both starting with x64
    echo "Warning: Unknown architecture $ARCH"
    BINARIES=("/usr/local/bin/file-server-x64" "/usr/local/bin/file-server-arm64")
    NAMES=("x64" "arm64")
  fi
  
  FILE_SERVER_BINARY=""
  
  # Try each binary in order
  for i in 0 1; do
    BINARY="${BINARIES[$i]}"
    NAME="${NAMES[$i]}"
    
    if [ ! -x "$BINARY" ]; then
      echo "Binary $NAME not found or not executable"
      continue
    fi
    
    echo "Testing $NAME binary..."
    
    # Try to execute and check for errors
    # Exit codes: 126 = cannot execute, 133 = Rosetta/emulation failure
    if timeout 2 "$BINARY" --help >/dev/null 2>&1; then
      echo "✓ $NAME binary is compatible"
      FILE_SERVER_BINARY="$BINARY"
      break
    else
      EXIT_CODE=$?
      if [ $EXIT_CODE -eq 126 ] || [ $EXIT_CODE -eq 133 ]; then
        echo "✗ $NAME binary: Architecture mismatch (exit code $EXIT_CODE)"
      elif [ $EXIT_CODE -eq 124 ]; then
        echo "✓ $NAME binary timed out but seems to work (this is OK)"
        FILE_SERVER_BINARY="$BINARY"
        break
      else
        echo "✗ $NAME binary failed with exit code $EXIT_CODE"
      fi
    fi
  done
  
  if [ -z "$FILE_SERVER_BINARY" ]; then
    echo "Warning: No compatible file server binary found, skipping..."
    return
  fi
  
  echo "Using file server binary: $FILE_SERVER_BINARY"
  
  # Run the file server in background with auto-restart
  (
    while true; do
      echo "Starting file server (attempt at $(date))"
      $FILE_SERVER_BINARY || echo "File server crashed (exit code: $?), restarting in 2 seconds..."
      sleep 2
    done
  ) &
  FILE_SERVER_PID=$!
  
  echo "File server started in background (PID: $FILE_SERVER_PID)"
}

backup_on_shutdown() {
  echo "Performing backup before shutdown..."
  
  # Backup each world directory and plugins via file server
  local dir='/data'
  echo "Backing up $dir..."
    
  # Use curl to trigger backup via file server on port 8083
  if curl -s -f "http://localhost:8083${dir}?backup=true" > /tmp/backup_result.json 2>&1; then
    echo "✓ Backup completed for $dir"
    cat /tmp/backup_result.json
  else
    echo "✗ Warning: Backup failed for $dir (continuing anyway)"
    cat /tmp/backup_result.json 2>&1 || true
  fi
  
  echo "Backup process completed"
}

kill_background_processes() {
  echo "Killing background processes..."
  
  # Kill file server process and its children
  if [ -n "${FILE_SERVER_PID:-}" ]; then
    echo "Killing file server (PID: $FILE_SERVER_PID) and its children..."
    # Kill the entire process group
    pkill -KILL -P "$FILE_SERVER_PID" 2>/dev/null || true
    kill -KILL "$FILE_SERVER_PID" 2>/dev/null || true
  fi
  
  # Kill HTTP proxy process and its children
  if [ -n "${HTTP_PROXY_PID:-}" ]; then
    echo "Killing HTTP proxy (PID: $HTTP_PROXY_PID) and its children..."
    # Kill the entire process group
    pkill -KILL -P "$HTTP_PROXY_PID" 2>/dev/null || true
    kill -KILL "$HTTP_PROXY_PID" 2>/dev/null || true
  fi
  
  echo "Background processes terminated"
}

handle_shutdown() {
  echo "Received SIGTERM, initiating graceful shutdown..."
  
  # Forward SIGTERM to the main process (Minecraft server)
  if [ -n "${MAIN_PID:-}" ]; then
    echo "Sending SIGTERM to main process (PID: $MAIN_PID)..."
    kill -TERM "$MAIN_PID" 2>/dev/null || true
    
    # Wait for main process to exit gracefully (with timeout)
    echo "Waiting for main process to exit gracefully..."
    for i in $(seq 1 60); do
      if ! kill -0 "$MAIN_PID" 2>/dev/null; then
        echo "Main process exited gracefully"
        break
      fi
      sleep 1
    done
    
    # Force kill if still running after timeout
    if kill -0 "$MAIN_PID" 2>/dev/null; then
      echo "Main process did not exit in time, forcing shutdown..."
      kill -KILL "$MAIN_PID" 2>/dev/null || true
    fi
  fi
  
  # Run backup after main process has stopped
  backup_on_shutdown
  
  # Kill all background processes
  kill_background_processes
  
  # Exit
  echo "Shutdown complete"
  exit 0
}

restore_from_backup() {
  echo "Checking for available backups to restore..."
  write_status "Checking for backups"
  
  # Check if we have AWS credentials configured
  if [ -z "${AWS_ACCESS_KEY_ID:-}" ] || [ -z "${AWS_ENDPOINT_URL:-}" ] || [ -z "${DATA_BUCKET_NAME:-${DYNMAP_BUCKET:-}}" ]; then
    echo "No R2 credentials found, skipping restore"
    return
  fi
  
  BUCKET="${DATA_BUCKET_NAME:-${DYNMAP_BUCKET:-}}"
  
  # Wait for file server to be ready (max 30 seconds)
  echo "Waiting for file server to be ready..."
  write_status "Waiting for file server"
  for i in $(seq 1 60); do
    # Check if file server responds (even with 404, it means it's running)
    if curl -s -o /dev/null -w "%{http_code}" "http://localhost:8083/" 2>/dev/null | grep -q "^[0-9]\{3\}$"; then
      echo "File server is ready"
      break
    fi
    if [ $i -eq 60 ]; then
      echo "Warning: File server did not become ready, skipping restore"
      return 1
    fi
    sleep 0.5
  done
  
  # Wait for HTTP proxy control connection to be established (max 30 seconds)
  echo "Waiting for HTTP proxy control connection..."
  write_status "Waiting for HTTP proxy connection"
  for i in $(seq 1 60); do
    PROXY_STATUS=$(curl -s "http://localhost:3128/healthcheck" 2>/dev/null || echo "")
    if [ "$PROXY_STATUS" = "CONNECTED" ]; then
      echo "HTTP proxy control connection is CONNECTED"
      break
    fi
    if [ $i -eq 60 ]; then
      echo "Warning: HTTP proxy control connection not established, skipping restore"
      return 1
    fi
    if [ -n "$PROXY_STATUS" ]; then
      echo "HTTP proxy status: $PROXY_STATUS (waiting for CONNECTED...)"
    fi
    sleep 0.5
  done
  
  # Restore the entire /data directory
  dir_name="data"
  
  # Check if directory already exists and has content (e.g., level.dat indicates a world exists)
  if [ -d "/$dir_name" ] && [ -f "/$dir_name/level.dat" ]; then
    echo "Directory /$dir_name already exists with world data (level.dat found), skipping restore"
    return
  fi
  
  echo "Looking for backups for $dir_name..."
  
  # List backups for this directory from R2
  # Note: S3 list returns keys in lexicographic (alphabetical) ascending order
  # Our backup naming uses reverse-epoch seconds as prefix, so ascending order = newest first
  # Format: backups/<reverseEpochSec>_<YYYYMMDDHH>_<dir>.tar.gz
  LIST_URL="${AWS_ENDPOINT_URL}/${BUCKET}/?prefix=backups/&delimiter="
  
  if ! BACKUP_LIST=$(curl -s -f "$LIST_URL" 2>&1); then
    echo "Warning: Failed to list backups for $dir_name, skipping restore"
    return 1
  fi
  
  # Extract backup keys that end with _<dir_name>.tar.gz
  # S3 returns them in ascending lex order, which means newest-first due to reverse-epoch prefix
  # Just take the first match (newest)
  LATEST_BACKUP=$(echo "$BACKUP_LIST" | grep -o '<Key>backups/[^<]*_'"${dir_name}"'\.tar\.gz</Key>' | sed 's/<Key>//g' | sed 's|</Key>||g' | head -n 1)
  
  if [ -z "$LATEST_BACKUP" ]; then
    echo "No backups found for $dir_name, skipping restore"
    return
  fi
  
  echo "Found latest backup: $LATEST_BACKUP"
  echo "Restoring $dir_name from $LATEST_BACKUP..."
  write_status "Restoring world data from backup"
  
  # Call the file server restore endpoint
  RESTORE_URL="http://localhost:8083/${dir_name}?restore=${LATEST_BACKUP}"
  
  if curl -s -f "$RESTORE_URL" > /tmp/restore_result.json 2>&1; then
    echo "✓ Restore completed for $dir_name"
    cat /tmp/restore_result.json
  else
    echo "✗ Warning: Restore failed for $dir_name"
    cat /tmp/restore_result.json 2>&1 || true
  fi
  
  echo "Restore process completed"
}


printenv

write_status "Initializing services"

echo "Starting services..."

# Setup hteetp binary
write_status "Setting up hteetp"
setup_hteetp

# Start the file server
write_status "Starting file server"
start_file_server

# Start the HTTP proxy server
write_status "Starting HTTP proxy"
start_http_proxy

# Start Tailscale in background
start_tailscale

# Restore from backups before starting Minecraft server
write_status "Checking for backups to restore"
restore_from_backup || (sleep 15 && restore_from_backup)

# Install optional plugins
write_status "Installing optional plugins"
do_optional_plugins || true

# Configure Dynmap if R2 credentials are available
write_status "Configuring Dynmap"
configure_dynmap

echo "Services started, launching main application..."
echo "Command: $@"

write_status "Starting Minecraft server"

# Set up SIGTERM trap
trap handle_shutdown SIGTERM

# Execute the main command (Minecraft server) & pipe to hteetp in background
"$@" | hteetp --host 0.0.0.0 --port 8082 --size 1M --text &
MAIN_PID=$!

echo "Main process started with PID: $MAIN_PID"
write_status "Minecraft server running"

# Wait for main process to exit
wait "$MAIN_PID"
EXIT_CODE=$?

echo "Main process exited with code: $EXIT_CODE, performing backup..."
backup_on_shutdown

# Kill all background processes
kill_background_processes

exit $EXIT_CODE
