/*
Dummy slam that outputs only zeroes...
*/
#include <fstream>
#include <iostream>
#include <iterator>
#include <string>
#include <set>
#include <exception>

// parse configuration files
#include <boost/property_tree/ptree.hpp>
#include <boost/property_tree/json_parser.hpp>
#include <boost/foreach.hpp>
namespace pt = boost::property_tree;

// parse CLI flags
#include <boost/program_options.hpp>
namespace po = boost::program_options;


// https://www.boost.org/doc/libs/1_67_0/doc/html/property_tree/tutorial.html
struct Settings
{
    std::string m_input_file;
    int m_nb_poses = 0;
    bool no_live_view = false;
    void load(const std::string &filename);
};