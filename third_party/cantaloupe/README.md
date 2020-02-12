# Usage
```bash
docker build --tag cantaloupe .

docker run --name qaboard_iiif_cantaloupe-production -p 0.0.0.0:8182:8182 -v cache_cantaloupe:/var/cache/cantaloupe -v /:/repository -v /srv/cantaloupe:/srv/cantaloupe --detach --restart always -it cantaloupe

```
## Image formats
https://medusa-project.github.io/cantaloupe/manual/3.4/images.html
http://iipimage.sourceforge.net/documentation/images/


### Use better icons (?)
```bash
git clone https://github.com/peterthomet/openseadragon-flat-toolbar-icons
cp -f openseadragon-flat-toolbar-icons/images/* /stage/algo_data/ci/openseadragon/images
cd /stage/algo_data/ci/openseadragon/images
mkdir _resized
find . -maxdepth 1 -iname "*.png" | xargs -L1 -I{} convert -resize 50% "{}" _resized/"{}"
mv _resized/* .
```

# Forked from [cihm-cantaloupe](https://github.com/c7a/cihm-cantaloupe)

`cihm-cantaloupe` is Canadiana's [Cantaloupe](https://medusa-project.github.io/cantaloupe/) configuration.

## configuration

`cihm-cantaloupe`'s configuration expects `config.json` to exist in the root directory of this repository, with the following properties set:

      {
        "repositoryBase": "/path/to/repositories"
        "secrets": {"key": "secret"}
      }

## Usage

      $ docker-compose up --build

Sets up an instance of Cantaloupe on localhost, port 8182. Note that environment variable VERSION allows you to set the version of Cantaloupe you wish to install.
