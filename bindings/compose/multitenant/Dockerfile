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
COPY deploy/multitenant/ ./deploy/multitenant/
COPY server.js ./
COPY .browserslistrc ./
RUN npm ci --include=dev --omit=optional --force \
    && node -e "console.log('COMPOSE_BROWSER_TARGETS=' + JSON.stringify(require('browserslist')(undefined, {path: process.cwd()}).sort()))" \
    && npm prune --omit=dev --omit=optional --ignore-scripts

FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53
ADD --checksum=sha256:f9da5d0c299139db5236b63bdbd5cc20f6e1267db989c51d6444f429150c158b https://github.com/xataio/pgstream/releases/download/v1.6.0/pgstream.linux.amd64 /usr/local/bin/pgstream
RUN chmod 0555 /usr/local/bin/pgstream
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
