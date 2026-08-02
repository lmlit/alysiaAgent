FROM node:22-alpine AS builder
RUN apk add --no-cache python3 make g++  # for better-sqlite3 native build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
RUN npm install -g pnpm@8 && pnpm install --frozen-lockfile
COPY packages/core/src packages/core/src/
COPY packages/core/tsconfig.json packages/core/
COPY packages/server/src packages/server/src/
COPY packages/server/tsconfig.json packages/server/
COPY tsconfig.base.json ./
RUN pnpm -r build && \
    node -e "const{readdirSync,readFileSync,writeFileSync,statSync}=require('fs');const{join}=require('path');function fix(d){readdirSync(d).forEach(f=>{const p=join(d,f);if(statSync(p).isDirectory()){if(!f.startsWith('.'))fix(p)}else if(f.endsWith('.js')){let c=readFileSync(p,'utf8');const r=c.replace(/from\s*'(\.[^']+)'/g,(m,q)=>q.endsWith('.js')?m:'from \\''+q+'.js\\'');if(r!==c)writeFileSync(p,r)}})}fix('packages')"

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/core/package.json ./packages/core/
COPY --from=builder /app/packages/server/dist ./packages/server/dist
COPY --from=builder /app/packages/server/package.json ./packages/server/
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=builder /app/packages/server/node_modules ./packages/server/node_modules
COPY --from=builder /app/pnpm-workspace.yaml ./
RUN mkdir -p /app/node_modules/@alysia && \
    ln -sf ../../packages/core /app/node_modules/@alysia/core && \
    ln -sf ../../packages/server /app/node_modules/@alysia/server
EXPOSE 6185
CMD ["node", "packages/server/dist/bootstrap.js"]
