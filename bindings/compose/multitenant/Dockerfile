# Native framed intake source e0dcdb9f537e426bdb17fc2915a480c734209264.
# Maintained upstream plus cumulative patch; pgstream-source.json records provenance.
FROM golang:1.26.11-alpine@sha256:f496f8c537ed506626ee1a6913afb32c45068a48697163c088f604cc775a0c38 AS pgstream-build
RUN apk add --no-cache git
WORKDIR /src/pgstream
RUN git init \
    && git remote add origin https://github.com/xataio/pgstream.git \
    && git fetch --depth=1 origin 97d7ab464f0accf6cf1373b3c3f7b328debae4b9 \
    && git checkout --detach FETCH_HEAD \
    && test "$(git rev-parse HEAD)" = 97d7ab464f0accf6cf1373b3c3f7b328debae4b9
COPY deploy/multitenant/pgstream-exact-handover.patch /tmp/pgstream-exact-handover.patch
RUN echo '9efeeb30a2b5a4b9a5826b70ad107863f6ad64e6e031463e5834a52b1be983e7  /tmp/pgstream-exact-handover.patch' | sha256sum -c - \
    && git apply --check /tmp/pgstream-exact-handover.patch \
    && git apply /tmp/pgstream-exact-handover.patch \
    && CGO_ENABLED=0 GOTOOLCHAIN=local GOMAXPROCS=2 GOOS=linux GOARCH=amd64 go build -p 2 -trimpath -buildvcs=false -o /out/pgstream . \
    && echo 'eac69908e214dd42c19a96761ee0fabcadc1b5c7e89c747614df59b458d82a14  /out/pgstream' | sha256sum -c -

FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS build
WORKDIR /opt/app
COPY package.json package-lock.json .babelrc ./
COPY bundle/ ./bundle/
COPY webpack/ ./webpack/
COPY bin/ ./bin/
COPY lib/ ./lib/
COPY static/ ./static/
COPY views/ ./views/
COPY translations/ ./translations/
COPY migrations/ ./migrations/
COPY scripts/diagnose-data.js ./scripts/diagnose-data.js
COPY server.js ./
COPY .browserslistrc ./
RUN npm ci --include=dev --omit=optional --force \
    && node -e "console.log('COMPOSE_BROWSER_TARGETS=' + JSON.stringify(require('browserslist')(undefined, {path: process.cwd()}).sort()))" \
    && npm prune --omit=dev --omit=optional --ignore-scripts
# Deployment-only changes do not alter dependency or browser compilation.
COPY deploy/multitenant/ ./deploy/multitenant/

FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53
COPY --from=pgstream-build --chmod=0555 /out/pgstream /usr/local/bin/pgstream
WORKDIR /opt/app
ENV NODE_ENV=production
ARG NS_SOURCE_COMMIT
ARG NS_DEPLOY_COMMIT
ENV NS_SOURCE_COMMIT=${NS_SOURCE_COMMIT}
COPY --from=build --chown=node:node /opt/app /opt/app
# Immutable image-local binding, not the host-only preparation overlay marker.
RUN node -e 'const f=require("node:fs"),pin=k=>{const v=process.env[k];if(v&&!/^[a-f0-9]{40}$/.test(v))throw Error("IMAGE_SOURCE_INVALID");return v||null;};f.writeFileSync("deploy/multitenant/.image-source.json",JSON.stringify({version:1,coreCommit:pin("NS_SOURCE_COMMIT"),deployCommit:pin("NS_DEPLOY_COMMIT")})+"\n",{mode:0o444,flag:"wx"});f.chmodSync("deploy/multitenant/.image-source.json",0o444);'
USER node
CMD ["node", "deploy/multitenant/entrypoint.js", "api"]
