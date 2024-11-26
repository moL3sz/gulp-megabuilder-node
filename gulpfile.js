const gulp = require('gulp');
const webpack = require('webpack-stream');
const terser = require('gulp-terser');
const path = require("path")
const fs = require("fs")
const gulpSSH = require("gulp-ssh")
const scp = require("gulp-scp")
const { exec } = require("child_process");
const ftp = require('basic-ftp');
const gutil = require("gulp-util");
const { constrainedMemory } = require('process');


/* ==== Konfiguráció ==== */
const config = {
  ssh: {
    host: '172.28.44.237',  // Távoli szerver IP vagy domain
    username: 'test',            // Távoli felhasználónév
    password: 'test'        // Távoli szerver jelszava
  },
  scripts: {
    server: {
      dest: 'build',       // Kimeneti mappa
      entry: "index.ts",
      srcDir: "server\\src"
    },
    client: {
      dir: "client/",
      dest: "client/dist"
    }

  },
  remote: {
    server: "/mnt/wwwdata/server",
    client: "/mnt/wwwdata/client"
  },
  // Docker run command on the server
  docker: {
    client: "",
    server: {
      path: "/server",
      dockerImageName: "server-api",
      dockerImageTag: "v1",
      run: " docker run -d -p 3000:3000 --name ${imageName} ${imageName}:${tag}",
      ftp: {
        host: "172.28.44.237",
        username: "test",
        password: "test",
        port: 21,
      }
    }
  }
};


/* === Pipes ==== */

// Server pipes
function cleanBeforeServer() {
  return new Promise(resolve => {
    fs.rmSync(config.scripts.server.dest, { force: true, recursive: true })
    resolve(true)
  })
}
function bundleServer() {
  /* === Segéd függvények */
  function createEntries(directory) {
    const entries = {};

    const processDirectory = (dir) => {
      const dirName = path.basename(dir);
      const files = fs.readdirSync(dir).filter((file) => !fs.statSync(path.join(dir, file)).isDirectory());
      const dist_dir = dir.replace("src", config.scripts.server.dest)
      if (files.length > 0) {
        if (dirName == "src") {
          entries[`index`] = files.map((file) => path.join(dir, file));

        }
        else {
          entries[`${dist_dir}\\${dirName}`] = files.map((file) => path.join(dir, file));

        }
      }

      fs.readdirSync(dir).forEach((sub) => {
        const subPath = path.join(dir, sub);
        if (fs.statSync(subPath).isDirectory()) {
          processDirectory(subPath);
        }
      });
    };

    processDirectory(directory);
    console.log(entries)
    return entries;
  }

  // Webpack konfiguráció
  const webpackConfig = {
    mode: 'production', // Állítsd "development"-re, ha debugolni szeretnéd
    output: {
      filename: '[name].js', // A kulcs alapján 
      path: path.join(__dirname, config.scripts.server.dest),
      clean: true, // Automatikusan törli az előző build fájlokat
    },
    entry: createEntries(path.resolve(__dirname, config.scripts.server.srcDir)),
    target: 'node', // Backend Node.js környezethez
    module: {
      rules: [
        {
          test: /\.ts$/,
          exclude: /node_modules/,
          use: 'ts-loader',
        },
        {
          test: /\.js$/,
          exclude: /node_modules/,
          use: {
            loader: 'babel-loader', // Ha ES6+ kódot írsz
            options: {
              presets: ['@babel/preset-env'],
            },
          },
        },
      ],
    },
    resolve: {
      extensions: ['.js', '.ts'],
    },
    optimization: {
      minimize: false, // Ha nem akarod minify-olni a bundle-t
      splitChunks: {
        chunks: 'all', // Az összes chunk szétbontása
        cacheGroups: {
          express: {
            test: /[\\/]node_modules[\\/]express[\\/]/, // Csak az express modulokat és annak chunkjait rakja külön fájlba
            name: 'express', // A fájl neve: express.[hash].bundle.js
            chunks: 'all',
            priority: 10, // Ha van más cache group, ezt előrébb veszi
          },
        },
      },
    },
  };

  return gulp
    .src(path.join(config.scripts.server.srcDir, config.scripts.server.entry))
    .pipe(webpack(webpackConfig))
    .pipe(terser()) // Minify-olás
    .pipe(gulp.dest(config.scripts.server.dest));
}
function deployServerSSH() {
  const ssh = new gulpSSH({
    ignoreErrors: false,
    sshConfig: config.ssh
  });
  return gulp
    .src(config.scripts.server.dest + "/**/*")
    .pipe(ssh.dest(config.remote.server))
}

// |-- Docker pipes
function buildServerDocker(done) {
  const imageName = config.docker.server.dockerImageName;
  const tag = config.docker.server.dockerImageTag;
  const serverPath = path.join(__dirname, config.docker.server.path)
  const buildCommand = `docker build -t ${imageName}${tag ? ":" + tag : ""} ${serverPath}`;
  console.log(`Building Docker image: ${imageName}${tag ? ":" + tag : ""}`);
  exec(buildCommand, (err, stdout, stderr) => {
    if (err) {
      console.error(`Error during Docker build: ${stderr}`);
      done(err);
    } else {
      console.log(stdout);
      done();
    }
  });
}
function saveServerDocker(done) {
  const imageName = config.docker.server.dockerImageName;
  const tag = config.docker.server.dockerImageTag;
  const tarFileName = `${imageName}${tag ? "_" + tag : ""}.tar`;
  const saveCommand = `docker save ${imageName}${tag ? ":" + tag : ""} -o ${path.join(__dirname, config.docker.server.path, tarFileName)}`;
  console.log(`Saving Docker image as: ${tarFileName}`);
  exec(saveCommand, (err, stdout, stderr) => {
    if (err) {
      console.error(`Error during Docker save: ${stderr}`);
      done(err);
    } else {
      console.log(stdout);
      done();
    }
  });
}
async function deployServerDocker(done) {
  const imageName = config.docker.server.dockerImageName;
  const tag = config.docker.server.dockerImageTag;
  const tarFileName = `${imageName}${tag ? "_" + tag : ""}.tar`;
  console.log(`Uploading ${tarFileName} to remote server...`);
  const localTarFile = path.join(__dirname, config.docker.server.path, tarFileName);


  const client = new ftp.Client();
  const {host, password, username,port} = config.docker.server.ftp
  client.ftp.verbose = true;
    const ftpConfig = {
    host: host,
    user: username,
    password: password,
    port: port
  }

  try {
    // Kapcsolódás a szerverhez
    await client.access(ftpConfig);

    // Fájlok feltöltése
    await client.uploadFrom(localTarFile, config.remote.server + "/" + tarFileName);
    done()
  } catch (e) {
    console.error(e)
  }
  finally{
    client.close()
  }

}

function runServerDocker(done) {
  const imageName = config.docker.server.dockerImageName;
  const tag = config.docker.server.dockerImageTag;
  const tarFileName = `${imageName}${tag ? "_" + tag : ""}.tar`;
  const ssh = new gulpSSH({
    ignoreErrors: false,
    sshConfig: config.ssh
  });
  const runCommadnd = config.docker.server.run
    .replaceAll("${imageName}", imageName)
    .replaceAll("${tag}", tag)
  

  const dockerCommands = `
    docker container inspect ${imageName} &&
    docker container rm -f ${imageName} &&
    docker image import ${config.remote.server}/${tarFileName} &&
    ${runCommadnd}
  `;

  ssh
    .exec([dockerCommands], { filePath: 'commands.log' })
    .on('data', (chunk) => {
      process.stdout.write(chunk.toString());
    })
    .on('error', (err) => {
      console.error('Error during remote execution:', err);
      done(err);
    })
    .on('end', () => {
      console.log('Docker image successfully loaded and container started.');
      done();
    });

}


// Client pipes
function bundleClient() {

  return new Promise(resolve => {
    exec('npm run build', { cwd: config.scripts.client.dir }, (err, stdout, stderr) => {
      if (err) {
        console.error(stderr);
        resolve(err);
      } else {
        console.log(stdout);
        resolve(true);
      }
    });
  })
}
function deployClientSSH() {
  const ssh = new gulpSSH({
    ignoreErrors: false,
    sshConfig: config.ssh
  });
  return gulp
    .src(config.scripts.client.dest + "/**/*")
    .pipe(ssh.dest(config.remote.client))
}
function deployClientDocker() {

}

// Server tasks
exports["build-server"] = gulp.series(cleanBeforeServer, bundleServer)
exports["deploy-server-ssh"] = gulp.series(cleanBeforeServer, bundleServer, deployServerSSH)
exports["deploy-server-docker"] = gulp.series(cleanBeforeServer, bundleServer, buildServerDocker, saveServerDocker, deployServerDocker, runServerDocker);

// Client task
exports["build-client"] = gulp.series(bundleClient)
exports["deploy-client-ssh"] = gulp.series(bundleClient, deployClientSSH)
exports["deploy-client-docker"] = null

// Bulk deploy
// Server, API, etc..
exports["deploy-all-ssh"] = gulp.parallel(
  exports["deploy-server-ssh"],
  exports["deploy-client-ssh"],
)
exports["deploy-all-docker"] = null