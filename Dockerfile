# ============================ Build stage ============================
FROM node:20-alpine AS builder

WORKDIR /app

# Instala TODAS as dependências (inclui devDependencies: typescript, @types...)
COPY package*.json ./
RUN npm ci

# Compila o TypeScript
COPY . .
RUN npm run build

# ============================ Production stage ============================
FROM node:20-alpine

WORKDIR /app

# Binários necessários em runtime:
#   ghostscript        -> converte PDF em PCL/PS (elimina o erro de PDF Direct Print)
#   ghostscript-fonts  -> fontes para o Ghostscript renderizar texto
#   samba-client       -> comando smbclient (impressão em filas \\host\fila do Windows)
RUN apk add --no-cache ghostscript ghostscript-fonts samba-client

# Só dependências de produção
COPY package*.json ./
RUN npm ci --omit=dev

# Artefato compilado
COPY --from=builder /app/dist ./dist

EXPOSE 4005

CMD ["npm", "start"]
