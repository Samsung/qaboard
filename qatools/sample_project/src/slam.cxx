#include <sample_project/slam.hpp>



int main (int argc, char *argv[])
{
    // Parse CLI arguments using Boost's program_options
    // https://www.boost.org/doc/libs/1_66_0/doc/html/program_options/tutorial.html
    bool no_live_view = false;
    po::options_description desc("Allowed options");
    desc.add_options()
        ("help", "produce help message")
        ("input", po::value<std::string>()->required(), "DVS recording (.bin file)")
        ("output", po::value<std::string>(), "Directory where we should output results. Defaults to the current workind directory.")
        ("paramfile", po::value<std::vector<std::string>>(), "The default parameters will be overriden with those files")
        ("no-live-view", po::bool_switch(&no_live_view), "Don't display a GUI with debug info, eg for headless CI use.")   
    ;
    po::variables_map vm;
    po::store(po::parse_command_line(argc, argv, desc), vm);
    po::notify(vm);    

    if (vm.count("help")) {
        std::cout << desc << std::endl;
        return 0;
    }

   // Load multiple configuration files, each overloading the previous settings
   Settings settings;
   for(auto& paramfile :  vm["paramfile"].as<std::vector<std::string>>()) {
     settings.load(paramfile);
   }

    // A real SLAM would use this flag to NOT display GUI windows
    // during headless runs - eg during the CI 
    if (no_live_view) {
        std::cout << "DEBUG: --no-live-view was set" << std::endl;
    }

   // Write the dummy SLAM results
   std::string output_directory = vm["output"].as<std::string>();
   std::string camera_poses_filepath = output_directory + "/camera_poses_debug.txt";
   std::ofstream fout(camera_poses_filepath);
   std::cout << "DEBUG: writing to " <<  camera_poses_filepath << std::endl;
   std::cout << "DEBUG: poses: " <<  settings.m_nb_poses << std::endl;

   for (int i=0; i<settings.m_nb_poses; i++) {
       // zeroes in 3d
       auto zeroes = "0\t0\t0\t";
       // rotations, translations, time, confidence, tracking_good
       fout << zeroes << zeroes << i << "\t100\t1" << std::endl;
   }
  return 0;
}


void Settings::load(const std::string &filename)
{
    std::cout << "DEBUG: loading " <<  filename << std::endl;

    pt::ptree tree;
    pt::read_json(filename, tree);

    // override if it exists.
    m_nb_poses = tree.get("nb_poses", m_nb_poses);
}

