FROM node:24-alpine AS base

WORKDIR /usr/src/app

COPY package.json yarn.lock ./

# ---- Builder ----
FROM base AS builder

RUN yarn install --frozen-lockfile

COPY . .

RUN yarn build

# ---- Dependencies ----
FROM base AS deps

RUN yarn install --production --frozen-lockfile --ignore-scripts

# ---- Production ----
FROM node:24-alpine

WORKDIR /usr/src/app

ENV NODE_ENV=production

USER node

COPY --chown=node:node --from=builder /usr/src/app/dist ./dist
COPY --chown=node:node --from=deps /usr/src/app/node_modules ./node_modules

EXPOSE 3000

CMD [ "node", "dist/main" ]