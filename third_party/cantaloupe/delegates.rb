##
# Custom delegate for Canadiana's configuration of Cantaloupe
##

require 'cgi'
require 'uri'
require 'zlib'
require 'jwt'
require 'json'

class CustomDelegate
  attr_accessor :context

  @config = nil

  def self.config
    unless (@config)
      @config = JSON.parse(File.read("/etc/config.json"))
      @config["repositoryList"] = Dir.entries(@config["repositoryBase"]).grep_v(/^\.*$/)
    end
    @config
  end

  def extractJwt
    query = CGI.parse(URI.parse(context["request_uri"]).query || '')
    header_match = context["request_headers"]["Authorization"].match(/C7A2 (.+)/) if context["request_headers"]["Authorization"]

    return (query["token"] ? query["token"][0] : nil) ||
      context["cookies"]["c7a2_token"] ||
      (header_match ? header_match[0] : nil) ||
      nil
  end

  def validateJwt(token)
    jwtData = nil

    begin
      jwtData = JWT.decode(token, nil, false)[0]
    rescue JWT::DecodeError => e
      puts "JWT Decode error: #{e.message}"
      return nil
    end

    issuer = jwtData["iss"]
    unless (issuer)
      puts "JWT must indicate issuer in payload."
      return nil
    end

    signingKey = self.class.config["secrets"][issuer]
    unless (signingKey)
      puts "JWT cannot be decoded with unknown issuer '#{issuer}'."
      return nil
    end

    jwtData = nil
    begin
      jwtData = JWT.decode(token, signingKey, true, { :algorithm => 'HS256' })[0]
    rescue JWT::DecodeError => e
      puts "JWT Decode error: #{e.message}"
      return nil
    end

    return jwtData
  end

  def redirect(options = {})
  end

  def authorized?(options = {})
    return true
  end

  def extra_iiif2_information_response_keys(options = {})
    {}
  end

  def source(options = {})
    return "FilesystemSource"
  end

  def azurestoragesource_blob_key(options = {})
  end

  def filesystemsource_pathname(options = {})
    aip, partpath = CGI::unescape(context["identifier"]).split('/', 2)
    depositor, objid = aip.split('.')
    aip_hash = Zlib::crc32(aip).to_s[-3..-1]
    aip_path = nil;
    self.class.config["repositoryList"].each do |path|
      testpath = [self.class.config["repositoryBase"], path, depositor, aip_hash, aip].join("/")
      if File.directory?(testpath)
        aip_path = testpath
        break
      end
    end
    return nil unless aip_path
    # Note: For anything beyond a test script, don't trust 'partpath' (check for ../)
    return [aip_path, partpath].join("/") 
  end

  def httpsource_resource_info(options = {})
  end

  def jdbcsource_database_identifier(options = {})
  end

  def jdbcsource_media_type(options = {})
  end

  def jdbcsource_lookup_sql(options = {})
  end

  def s3source_object_info(options = {})
  end

  def overlay(options = {})
  end

  def redactions(options = {})
    []
  end
end

