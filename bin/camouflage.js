#!/usr/bin/env node
const child_process = require("child_process");
const cluster = require("cluster");
const express = require("express");
const metricsServer = express();
const AggregatorRegistry = require("prom-client").AggregatorRegistry;
const aggregatorRegistry = new AggregatorRegistry();
var argv = require("yargs").argv;
const yaml = require("js-yaml");
const winston = require("winston");
const path = require("path");
const fs = require("fs");
const os = require("os");
var configFile = argv.c || argv.config;
var help = argv.h || argv.help;
var init = argv._[0] === "init" ? "init" : null;
var restore = argv._[0] === "restore" ? "restore" : null;
const osCPUs = require("os").cpus().length;
const camouflage = require("../dist/index");
const site_root = path.join(child_process.execSync("npm root -g").toString().trim(), "camouflage-server");
const fse = require("fs-extra");
if (help) {
  console.log(
    [
      "Create a config.yml file as shown in the sample yml below",
      `loglevel: 'info'`,
      `cpus: 1`,
      `protocols:`,
      ` http:`,
      `   mocks_dir: "./mocks"`,
      `   port: 8080"`,
      ` https:`,
      `   enable: false`,
      `   port: 8443`,
      `   cert: "./certs/server.cert"`,
      `   key: "./certs/server.key"`,
      ` grpc:`,
      `   enable: false`,
      `   port: 5000`,
      `   mocks_dir: "./grpc/mocks"`,
      `   protos_dir: "./grpc/protos"`,
    ].join("\n")
  );
  process.exit(1);
}
if (init) {
  if (fs.readdirSync(path.resolve(process.cwd())).length === 0) {
    fse.copySync(path.join(site_root, "mocks"), path.join(process.cwd(), "mocks"));
    fse.copySync(path.join(site_root, "grpc"), path.join(process.cwd(), "grpc"));
    fse.copySync(path.join(site_root, "config.yml"), path.join(process.cwd(), "config.yml"));
    fse.mkdirSync(path.join(process.cwd(), "certs"));
  } else {
    console.log("Current directory is not empty. Camouflage cannot initialize a project in a non empty directory.");
  }
  process.exit(1);
}
if (!configFile) {
  logger.error("Please provide a config file.");
  process.exit(1);
}
config = yaml.load(fs.readFileSync(configFile, "utf-8"));
const logger = winston.createLogger({
  level: config.loglevel,
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.simple(),
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.printf((log) => `${log.timestamp} ${log.level}: ${log.message}` + (log.splat !== undefined ? `${log.splat}` : " "))
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({
      filename: path.join(process.cwd(), "camouflage.log"),
    }),
  ],
});
if (restore) {
  if (fs.existsSync(path.resolve(os.homedir(), ".camouflage_backup"))) {
    logger.info("Restoring from previous backup.");
    fse.copySync(path.join(os.homedir(), ".camouflage_backup", "mocks"), path.resolve(config.protocols.http.mocks_dir));
    fse.copySync(path.join(os.homedir(), ".camouflage_backup", "grpc", "mocks"), path.resolve(config.protocols.grpc.mocks_dir));
    fse.copySync(path.join(os.homedir(), ".camouflage_backup", "grpc", "protos"), path.resolve(config.protocols.grpc.protos_dir));
    fse.copySync(path.join(os.homedir(), ".camouflage_backup", "certs", "server.key"), path.resolve(config.ssl.key));
    fse.copySync(path.join(os.homedir(), ".camouflage_backup", "certs", "server.cert"), path.resolve(config.ssl.cert));
    logger.info("Restore complete.");
  } else {
    logger.error("No existing backup found.");
  }
  process.exit(1);
}
let inputsKeys = [
  "mocks_dir",
  "http.port",
  "https.enable",
  "http2.enable",
  "grpc.enable",
  "ssl.key",
  "ssl.cert",
  "https.port",
  "http2.port",
  "grpc.host",
  "grpc.port",
  "grpc.mocks_dir",
  "grpc.protos_dir",
  "loglevel",
  "backup.enable",
  "backup.cron",
  "configFile",
];
let inputs = [
  config.protocols.http.mocks_dir,
  config.protocols.http.port,
  config.protocols.https.enable,
  config.protocols.http2.enable,
  config.protocols.grpc.enable,
  config.ssl.key || path.join(site_root, "certs", "server.key"),
  config.ssl.cert || path.join(site_root, "certs", "server.cert"),
  config.protocols.https.port || 8443,
  config.protocols.http2.port || 8081,
  config.protocols.grpc.host || "localhost",
  config.protocols.grpc.port || 4312,
  config.protocols.grpc.mocks_dir || path.join(site_root, "grpc", "mocks"),
  config.protocols.grpc.protos_dir || path.join(site_root, "grpc", "protos"),
  config.loglevel || "info",
  config.backup.enable || true,
  config.backup.cron || "0 * * * *",
  configFile,
];
const numCPUs = config.cpus || 1;
const monitoringPort = config.monitoring.port || 5555;
if (numCPUs > osCPUs) {
  logger.error("Number of CPUs specified is greater than or equal to availale CPUs. Please specify a lesser number.");
  process.exit(1);
}
if (cluster.isMaster) {
  logger.debug(`Camouflage configuration:\n========\n${inputsKeys.join(" | ")}\n========\n${inputs.join(" | ")}\n========\n`);
  logger.info(`[${process.pid}] Master Started`);
  // If current node is a master node, use it to start X number of workers, where X comes from config
  for (let i = 0; i < numCPUs; i++) {
    let worker = cluster.fork();
    // Attach a listner to each worker, so that if worker sends a restart message, running workers can be killed
    worker.on("message", (message) => {
      if (message === "restart") {
        for (let id in cluster.workers) {
          cluster.workers[id].process.kill();
        }
      }
    });
  }
  // If workers are killed or crashed, a new worker should replace them
  cluster.on("exit", (worker, code, signal) => {
    logger.warn(`[${worker.process.pid}] Worker Stopped ${new Date(Date.now())}`);
    let newWorker = cluster.fork();
    // Same listener to be attached to new workers
    newWorker.on("message", (message) => {
      if (message === "restart") {
        for (let id in cluster.workers) {
          cluster.workers[id].process.kill();
        }
      }
    });
  });
  metricsServer.get("/metrics", async (req, res) => {
    try {
      const metrics = await aggregatorRegistry.clusterMetrics();
      res.set("Content-Type", aggregatorRegistry.contentType);
      res.send(metrics);
    } catch (ex) {
      res.statusCode = 500;
      res.send(ex.message);
    }
  });

  metricsServer.listen(monitoringPort);
  logger.info(`Cluster metrics server listening to ${monitoringPort}, metrics exposed on http://localhost:${monitoringPort}/metrics`);
} else {
  camouflage.start(...inputs);
}
