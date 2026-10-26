FROM node:24-alpine AS base

WORKDIR /usr/src/app

COPY package.json yarn.lock ./

# ---- Builder ----
FROM base AS builder

RUN --mount=type=cache,target=/usr/local/share/.cache/yarn,sharing=locked \
  yarn install --frozen-lockfile

COPY . .

RUN yarn build

# ---- Dependencies ----
FROM base AS deps

RUN --mount=type=cache,target=/usr/local/share/.cache/yarn,sharing=locked \
  yarn install --production --frozen-lockfile --ignore-scripts

# ---- Runner ----
FROM node:24-alpine

WORKDIR /usr/src/app

ENV NODE_ENV=production
ENV GRACEFUL_SHUTDOWN_TIMEOUT_MS=0

USER node

COPY --from=deps /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/src/app/dist ./dist

EXPOSE 3000

CMD [ "node", "--enable-source-maps", "dist/main" ]