# Vault Agent configuration for the one-host Compose overlay. Paths only; no credential
# values. role_id and secret_id are files written by vault-agent-bootstrap.js into the
# private state directory and bind-mounted at /run/ns-vault-creds.
pid_file = "/tmp/vault-agent.pid"
disable_mlock = true
exit_after_auth = false

vault {
  address = "https://vault:8200"
  ca_cert = "/run/ns-ca/ca.crt"
}

auto_auth {
  method "approle" {
    mount_path = "auth/approle"
    config = {
      role_id_file_path = "/run/ns-vault-creds/role_id"
      secret_id_file_path = "/run/ns-vault-creds/secret_id"
      # The secret_id is read once and the file removed; the Agent keeps it in memory for
      # re-authentication after token_max_ttl. A restarted Agent needs a fresh secret_id
      # (vault-agent.sh secret-id). It never reaches the application containers.
      remove_secret_id_file_after_reading = true
    }
  }
  sink "file" {
    config = {
      # Read by the application on every Transit call (preview-config tokenFile).
      path = "/run/ns-vault/token"
      mode = 0600
    }
  }
}

# No listener, cache, api_proxy or template stanza: the application keeps its own small
# Transit client and only the token moves through the sink.
