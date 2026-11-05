FROM node:22-bookworm-slim AS build
WORKDIR /workspace/smartexit
COPY . .
RUN npm ci && npm run build --workspace @smartexit/api

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /workspace/smartexit/package.json ./package.json
COPY --from=build /workspace/smartexit/package-lock.json ./package-lock.json
COPY --from=build /workspace/smartexit/node_modules ./node_modules
COPY --from=build /workspace/smartexit/apps/api/package.json ./apps/api/package.json
COPY --from=build /workspace/smartexit/apps/api/dist ./apps/api/dist
EXPOSE 3001
CMD ["npm", "run", "start", "--workspace", "@smartexit/api"]
