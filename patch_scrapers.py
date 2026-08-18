"""Deploy compiled scraper JS files to VPS via SFTP."""
import paramiko, os, sys

HOST = "152.228.232.151"
USER = "ubuntu"
PASS = "Fides2026!Bot"

FILES = ["betsson.js", "bwin.js", "winamax.js", "williamhill.js", "daznbet.js"]
LOCAL_DIR = r"C:\Users\alexq\Downloads\Software stats fidesbot\surebet-tracker-pro\scraper\dist\scrapers"
REMOTE_DIR = "/home/ubuntu/scraper/dist/scrapers"

def deploy():
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, username=USER, password=PASS, timeout=30)
    sftp = client.open_sftp()

    for f in FILES:
        local = os.path.join(LOCAL_DIR, f)
        remote = f"{REMOTE_DIR}/{f}"
        if not os.path.exists(local):
            print(f"  SKIP (not found): {f}")
            continue
        sftp.put(local, remote)
        print(f"  OK: {f}")

    sftp.close()

    # Restart PM2 process
    _, stdout, stderr = client.exec_command("pm2 restart fidesbot-scanner 2>&1")
    out = stdout.read().decode()
    err = stderr.read().decode()
    print("PM2 restart:", out.strip() or err.strip() or "done")

    client.close()

if __name__ == "__main__":
    deploy()
