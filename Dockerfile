FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm install
COPY src ./src
RUN npm run build
RUN mkdir -p /app/data /app/tmp
EXPOSE 7088
CMD ["npm", "start"]
