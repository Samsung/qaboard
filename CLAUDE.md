# CLAUDE.md
This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.


## QA-Board Architecture

QA-Board is an experiment tracking framework with advanced viewers for algorithm, ML, and performance engineers. It consists of:

- **`qaboard/`** - Python CLI package that wraps user code and manages experiments
- **`backend/`** - Flask API with PostgreSQL database for managing runs and data  
- **`webapp/`** - React.js frontend for visualizing and comparing results
- **`services/`** - Infrastructure services (nginx, databases, message queues)
- **`website/`** - Docusaurus documentation site

## Development Commands

### Environment Setup
```bash
# Start full development environment
docker compose -f docker-compose.yml -f development.yml up -d

# At SIRC, run this first to mount important folders
./at-sirc-before-up.py

# With SIRC-specific config
docker compose -f docker-compose.yml -f development.yml -f sirc.yml up -d
```

### Frontend Development (React)
```bash
cd webapp
npm install
npm start                # Start dev server
npm run build           # Production build  
npm test                # Run tests
```

### Backend Development (Python Flask)
```bash
cd backend
# Backend runs in Docker, see docker-compose.yml
```

### Documentation Site
```bash
cd website  
yarn install
yarn start              # Start Docusaurus dev server
yarn build              # Build static site
```

### Python CLI Package
```bash
# Main qaboard package uses uv for dependencies
# Development dependencies include testing tools
uv sync --extra dev     # Install with dev dependencies
```

## Testing

### Python Tests
- **Framework**: `green` test runner (configured in pyproject.toml)
- **Backend tests**: `pytest` (in backend/pyproject.toml dev dependencies)
- **Type checking**: `mypy` 
- **Linting**: `flake8`
- **Test files**: Located in `tests/` directory

```bash
# Run Python tests (use green test runner)
green

# Type checking
mypy qaboard/

# Linting  
flake8 qaboard/
```

### Frontend Tests
```bash
cd webapp
npm test                # React test suite
```

## Key Technologies

- **Backend**: Python 3.11+, Flask, PostgreSQL, SQLAlchemy, Celery, Redis
- **Frontend**: React 18, Redux, TypeScript, Blueprint UI, D3.js, Plotly.js
- **Infrastructure**: Docker Compose, nginx, RabbitMQ
- **CLI**: Python with Click framework
- **Package Management**: `uv` for Python, `npm` for JavaScript

## Development Workflow

1. **Environment**: Use Docker Compose for full stack development
2. **Database**: PostgreSQL with Alembic migrations
3. **Task Queue**: LSF or Celery with RabbitMQ for background jobs
4. **Image Serving**: Cantaloupe IIIF server for advanced image viewing
5. **Authentication**: Supports local, LDAP, and SAML authentication

## Special Features

- **LSF Integration**: High-performance computing cluster support for batch jobs
- **Advanced Visualizations**: Images, videos, plots, 3D point clouds, flame graphs
- **Git Integration**: Version control awareness and commit tracking
- **Parameter Tuning**: Built-in optimization workflows with scikit-optimize
- **Bit Accuracy Testing**: Automated regression testing for algorithm validation

## Architecture Notes

The system follows a microservices pattern with Docker containers. The CLI submits jobs and uploads results, the backend processes data and stores in PostgreSQL, and the frontend fetches data via REST API to render visualizations. Services provide infrastructure like reverse proxy, image serving, and task processing.

Main entry points:
- CLI: `qa` command (from qaboard package)
- Backend API: Flask application served via uWSGI
- Frontend: React SPA served by nginx
- Documentation: Static Docusaurus site