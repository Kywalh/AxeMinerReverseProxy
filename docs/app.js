"use strict";

const minersList = document.getElementById("minersList");
const minerTemplate = document.getElementById("minerTemplate");
const domainInput = document.getElementById("domain");
const allowRestartInput = document.getElementById("allowRestart");
const validationMessage = document.getElementById("validationMessage");
const configOutput = document.getElementById("configOutput");
const commandsOutput = document.getElementById("commandsOutput");
const statusPill = document.getElementById("statusPill");

const addMinerButton = document.getElementById("addMinerButton");
const resetButton = document.getElementById("resetButton");
const generateButton = document.getElementById("generateButton");
const copyConfigButton = document.getElementById("copyConfigButton");
const downloadConfigButton = document.getElementById("downloadConfigButton");
const copyCommandsButton = document.getElementById("copyCommandsButton");

let generatedConfig = "";
let generatedCommands = "";

function defaultPort(index) {
  return 18443 + (index * 1000);
}

function defaultIp(index) {
  return `192.168.1.${201 + index}`;
}

function addMiner(values = {}) {
  const count = minersList.children.length;
  if (count >= 25) {
    showValidation("The generator supports up to 25 miners per configuration.");
    return;
  }

  const fragment = minerTemplate.content.cloneNode(true);
  const card = fragment.querySelector(".miner-card");
  const nameInput = fragment.querySelector(".miner-name");
  const ipInput = fragment.querySelector(".miner-ip");
  const portInput = fragment.querySelector(".miner-port");
  const removeButton = fragment.querySelector(".remove-miner");

  nameInput.value = values.name ?? `Miner #${count + 1}`;
  ipInput.value = values.ip ?? defaultIp(count);
  portInput.value = values.port ?? defaultPort(count);

  removeButton.addEventListener("click", () => {
    card.remove();
    renumberMiners();
    invalidateGeneratedOutput();
  });

  for (const input of [nameInput, ipInput, portInput]) {
    input.addEventListener("input", () => {
      input.classList.remove("invalid");
      invalidateGeneratedOutput();
    });
  }

  minersList.appendChild(fragment);
  renumberMiners();
  invalidateGeneratedOutput();
}

function renumberMiners() {
  [...minersList.querySelectorAll(".miner-card")].forEach((card, index) => {
    card.querySelector(".miner-title").textContent = `AxeOS Miner ${index + 1}`;
    card.querySelector(".remove-miner").disabled = minersList.children.length === 1;
  });
}

function resetForm() {
  minersList.innerHTML = "";
  domainInput.value = "miners.example.com";
  allowRestartInput.checked = true;
  addMiner({ name: "Miner #1", ip: "192.168.1.201", port: 18443 });
  addMiner({ name: "Miner #2", ip: "192.168.1.202", port: 19443 });
  clearValidation();
  invalidateGeneratedOutput(true);
}

function isValidDomain(value) {
  if (value.length > 253 || value.includes("://") || value.includes(":") || value.includes("/")) {
    return false;
  }

  const labels = value.split(".");
  if (labels.length < 2) return false;

  return labels.every(label => {
    if (!label || label.length > 63) return false;
    return /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label);
  });
}

function isValidIpv4(value) {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every(part => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const number = Number(part);
    return number >= 0 && number <= 255;
  });
}

function cleanMinerName(value, index) {
  const clean = value.trim().replace(/[\r\n#{};]/g, " ").replace(/\s+/g, " ");
  return clean || `Miner #${index + 1}`;
}

function readAndValidateForm() {
  clearValidation();
  document.querySelectorAll("input.invalid").forEach(input => input.classList.remove("invalid"));

  const domain = domainInput.value.trim().toLowerCase();
  const errors = [];

  if (!isValidDomain(domain)) {
    domainInput.classList.add("invalid");
    errors.push("Enter a valid public domain name, for example miners.example.com.");
  }

  const miners = [...minersList.querySelectorAll(".miner-card")].map((card, index) => {
    const nameInput = card.querySelector(".miner-name");
    const ipInput = card.querySelector(".miner-ip");
    const portInput = card.querySelector(".miner-port");

    const ip = ipInput.value.trim();
    const port = Number(portInput.value);

    if (!isValidIpv4(ip)) {
      ipInput.classList.add("invalid");
      errors.push(`Miner ${index + 1}: invalid local IPv4 address.`);
    }

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      portInput.classList.add("invalid");
      errors.push(`Miner ${index + 1}: public HTTPS port must be between 1 and 65535.`);
    }

    return {
      name: cleanMinerName(nameInput.value, index),
      ip,
      port,
      ipInput,
      portInput
    };
  });

  const seenPorts = new Map();
  const seenIps = new Map();

  miners.forEach((miner, index) => {
    if (seenPorts.has(miner.port)) {
      miner.portInput.classList.add("invalid");
      miners[seenPorts.get(miner.port)].portInput.classList.add("invalid");
      errors.push(`Public HTTPS port ${miner.port} is used by more than one miner.`);
    } else {
      seenPorts.set(miner.port, index);
    }

    if (seenIps.has(miner.ip)) {
      miner.ipInput.classList.add("invalid");
      miners[seenIps.get(miner.ip)].ipInput.classList.add("invalid");
      errors.push(`Local IP ${miner.ip} is used by more than one miner.`);
    } else {
      seenIps.set(miner.ip, index);
    }
  });

  if (errors.length > 0) {
    showValidation([...new Set(errors)].join("\n"));
    return null;
  }

  return {
    domain,
    allowRestart: allowRestartInput.checked,
    miners: miners.map(({ name, ip, port }) => ({ name, ip, port }))
  };
}

function proxyHeaders(ip) {
  return `        proxy_http_version 1.1;

        proxy_set_header Host ${ip};
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_read_timeout 90;`;
}

function buildServerBlock(setup, miner, index) {
  const restartLocation = setup.allowRestart ? `
    # Allow ONLY the AxeOS restart POST endpoint
    location ~ ^/api/system/restart/?$ {
        limit_except POST {
            deny all;
        }

        proxy_pass http://${miner.ip};

${proxyHeaders(miner.ip)}
    }
` : "";

  return `# -----------------------------------------------------------------------------
# AxeOS Miner ${index + 1}: ${miner.name}
# LAN: ${miner.ip}  |  WAN HTTPS port: ${miner.port}
# -----------------------------------------------------------------------------
server {
    listen ${miner.port} ssl;
    listen [::]:${miner.port} ssl;

    server_name ${setup.domain};

    ssl_certificate /etc/letsencrypt/live/${setup.domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${setup.domain}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
${restartLocation}
    # Everything else is READ ONLY
    location / {
        limit_except GET HEAD {
            deny all;
        }

        proxy_pass http://${miner.ip}/;

${proxyHeaders(miner.ip)}

        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}`;
}

function buildConfig(setup) {
  const restartText = setup.allowRestart
    ? "POST /api/system/restart is explicitly allowed; all other writes are blocked."
    : "All write methods are blocked, including remote restart.";

  const blocks = setup.miners.map((miner, index) => buildServerBlock(setup, miner, index)).join("\n\n");

  return `# AxeOS Miner Secure Reverse Proxy
# Generated with https://kywalh.github.io/AxeMinerReverseProxy/
# Recommended file: /etc/nginx/sites-available/axeos-miners
#
# Security policy:
# - GET and HEAD are allowed.
# - ${restartText}
# - TLS terminates on this NGINX reverse proxy.
#
# IMPORTANT: Certificates referenced below must already exist.

${blocks}
`;
}

function buildCommands(setup) {
  const natLines = setup.miners
    .map(miner => `# WAN TCP ${miner.port} -> <REVERSE-PROXY-LAN-IP>:${miner.port}    (${miner.name})`)
    .join("\n");

  return `# 1. Confirm that the Let's Encrypt certificate exists
sudo test -f /etc/letsencrypt/live/${setup.domain}/fullchain.pem && echo "Certificate found"

# 2. Create/edit the NGINX site and paste the generated configuration
sudo nano /etc/nginx/sites-available/axeos-miners

# 3. Enable the site
sudo ln -sfn /etc/nginx/sites-available/axeos-miners /etc/nginx/sites-enabled/axeos-miners

# 4. Validate NGINX BEFORE reloading it
sudo nginx -t

# 5. Reload only if the previous command reports success
sudo systemctl reload nginx

# Router/NAT forwarding to create
${natLines}`;
}

function generate() {
  const setup = readAndValidateForm();
  if (!setup) {
    statusPill.textContent = "Fix inputs";
    statusPill.classList.remove("success");
    return;
  }

  generatedConfig = buildConfig(setup);
  generatedCommands = buildCommands(setup);

  configOutput.textContent = generatedConfig;
  commandsOutput.textContent = generatedCommands;

  copyConfigButton.disabled = false;
  downloadConfigButton.disabled = false;
  copyCommandsButton.disabled = false;

  statusPill.textContent = `${setup.miners.length} miner${setup.miners.length > 1 ? "s" : ""} · generated`;
  statusPill.classList.add("success");

  if (window.innerWidth < 980) {
    configOutput.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function invalidateGeneratedOutput(hardReset = false) {
  if (hardReset) {
    generatedConfig = "";
    generatedCommands = "";
    configOutput.textContent = "Fill in your setup and click “Generate NGINX configuration”.";
    commandsOutput.textContent = "Installation commands will appear here.";
    copyConfigButton.disabled = true;
    downloadConfigButton.disabled = true;
    copyCommandsButton.disabled = true;
  }
  statusPill.textContent = "Ready";
  statusPill.classList.remove("success");
}

function showValidation(message) {
  validationMessage.textContent = message;
  validationMessage.classList.add("visible");
  validationMessage.style.whiteSpace = "pre-line";
}

function clearValidation() {
  validationMessage.textContent = "";
  validationMessage.classList.remove("visible");
}

async function copyText(text, button) {
  if (!text) return;

  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }

  const original = button.textContent;
  button.textContent = "Copied ✓";
  window.setTimeout(() => { button.textContent = original; }, 1400);
}

function downloadConfig() {
  if (!generatedConfig) return;
  const blob = new Blob([generatedConfig], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "axeos-miners";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

addMinerButton.addEventListener("click", () => addMiner());
resetButton.addEventListener("click", resetForm);
generateButton.addEventListener("click", generate);
copyConfigButton.addEventListener("click", () => copyText(generatedConfig, copyConfigButton));
copyCommandsButton.addEventListener("click", () => copyText(generatedCommands, copyCommandsButton));
downloadConfigButton.addEventListener("click", downloadConfig);

domainInput.addEventListener("input", () => {
  domainInput.classList.remove("invalid");
  clearValidation();
  invalidateGeneratedOutput();
});
allowRestartInput.addEventListener("change", () => invalidateGeneratedOutput());

resetForm();
